<div align="center">

<img src="docs/images/mascot.png" alt="MT5700M 5G Mascot" width="108" height="108" style="border-radius: 50%; box-shadow: 0 4px 16px rgba(0,0,0,0.12); margin-bottom: 8px;" />

# mt5700d · MT5700M 5G 模组管理

**适用于 OpenWrt / ImmortalWrt 平台的 MT5700M 5G 模组全功能控制中心与常驻守护套件**

[![Version](https://img.shields.io/badge/Version-v2.0.2-3b82f6?style=flat-square&logo=git&logoColor=white)](CHANGELOG.md)
[![OpenWrt CI](https://img.shields.io/github/actions/workflow/status/LianXia233/luci-app-mt5700/build-openwrt.yml?branch=main&label=Build%20OpenWrt&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/build-openwrt.yml)
[![Static Checks](https://img.shields.io/github/actions/workflow/status/LianXia233/luci-app-mt5700/checks.yml?branch=main&label=Checks&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/checks.yml)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square&logo=gnu&logoColor=white)](LICENSE)

[![OpenWrt](https://img.shields.io/badge/OpenWrt-24.10%20%7C%2025.x-00C49F?style=flat-square&logo=openwrt&logoColor=white)](https://openwrt.org/)
[![ImmortalWrt](https://img.shields.io/badge/ImmortalWrt-Compatible-f97316?style=flat-square)](https://immortalwrt.org/)
[![Backend](https://img.shields.io/badge/Backend-Rust%20%7C%20Tokio-DEA584?style=flat-square&logo=rust&logoColor=white)](src/rust/)
[![Architecture](https://img.shields.io/badge/Arch-x86__64%20%7C%20aarch64-8b5cf6?style=flat-square)](https://github.com/LianXia233/luci-app-mt5700/releases)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-0ea5e9?style=flat-square&logo=googlechrome&logoColor=white)](https://lianxia233.github.io/luci-app-mt5700/)
[![GitHub Stars](https://img.shields.io/github/stars/LianXia233/luci-app-mt5700?style=flat-square&logo=github)](https://github.com/LianXia233/luci-app-mt5700/stargazers)
[![主仓库](https://img.shields.io/badge/主仓库-GitHub-181717?style=flat-square&logo=github)](https://github.com/LianXia233/luci-app-mt5700)
[![镜像仓库](https://img.shields.io/badge/镜像仓库-CNB-2F54EB?style=flat-square)](https://cnb.cool/LianXia233/luci-app-mt5700)

<p align="center">
  <b>📦 单包融合交付</b>：集成 12 个原生 LuCI 现代化管理页面与高性能常驻后端 <code>/usr/bin/mt5700d</code><br>
  涵盖全自动 NDIS 拨号对账 · 真实射频打分看板 · 全网扫频 · 智能锁频 · 聊天式短信中心 · 交互式 AT 终端
</p>

</div>

---

> [!NOTE]
> **📌 仓库定位**
>
> - **GitHub 是主仓库**：[LianXia233/luci-app-mt5700](https://github.com/LianXia233/luci-app-mt5700) —— 源码、Issue 追踪、Release 发布均以此为准；
> - **CNB 是镜像仓库**：[cnb.cool/LianXia233/luci-app-mt5700](https://cnb.cool/LianXia233/luci-app-mt5700) —— 内容与主仓库保持同步，方便国内网络高速访问与固件包下载；
> - **提 Issue / 提建议请优先使用 GitHub**（[Issues](https://github.com/LianXia233/luci-app-mt5700/issues)）。

> [!WARNING]
> **⚠️ 独占运行与兼容性说明**
>
> 本插件是 MT5700M 专用拨号与管控插件，后端基于 Rust 独占持有模组 TTY 串口并直接调度 AT 事务。**本插件严禁与 QModem 等同样直接占用模组串口的插件同时运行**，否则会导致多进程争抢串口、AT 指令串流乱序、超时断线及拨号异常。
>
> **使用本插件即可独立完成接口创建、自动拨号、防火墙登记与掉线自愈**，无需安装或运行 QModem。安装本插件前请务必停用或卸载其他串口占用插件。

---

## 🌟 核心特性

| 特性维度 | 说明 |
|:---|:---|
| ⚡ **高性能异步常驻引擎** | 基于 **Rust + Tokio** 异步非阻塞事件驱动，常驻内存以 MB 量级计（随固件、配置与运行负载变化；不依赖任何第三方运行时），AT 事务通过异步互斥 + 优先级队列串行调度，杜绝多进程抢占 TTY 引起的数据截断与指令挂死。 |
| 🎯 **真实数据可信原则** | 严守四大铁律：**取不到如实说、缺口不连线、不估算速率、全链路可核对**。严格对照 3GPP 规范解析物理层射频指标，绝不注水或绘制伪造的平滑曲线。 |
| 🎛️ **12 大原生管理控制台** | 无缝融入 LuCI 原生路由菜单，覆盖网络状态仪表盘、APN 接入点、载波聚合、邻区扫频、定时锁频、模组升级、AT 终端等全生命周期功能。 |
| 💬 **现代聊天式短信中心** | 完整 PDU / Text 短信收发与长短信自动合并分段，呈现**双向 IM 聊天时间轴**；支持本地 ChaCha20 加密归档，模组闪存与路由存储无缝融合成单条时间轴。 |
| 🌐 **全自动拨号与全链路自愈** | USB NDIS / 转网口模式切换，承载网络链路状态守护与自动对账；缺失接口与防火墙 NAT 区域自动补齐，具备指数退避重拨与开机自启自愈。 |
| 🔔 **多通道多格式告警推送** | 支持**企业微信机器人**与 **QQ 机器人（官方 API v2）**，具备富文本 Markdown 表格卡片、内嵌跳转键盘与底部菜单，内置信号突变与定时巡检防刷屏节流保护。 |

---

## 📸 界面预览

### 网络状态控制台 (Dashboard)
控制台每秒采集模组底层射频指标，实时展示 RSRP、RSRQ、SINR、动态信号综合评分、5G NR 载波聚合状态、芯片微热力拓扑矩阵与动态 I/Q 星座图。

<div align="center">
  <img src="docs/images/network-status.png" alt="网络状态页面" width="880" style="max-width: 100%; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.15);" />
  <p><sub>图 1：网络状态控制台（展示 AT 通道状态、信号质谱打分及 5G NR 载波聚合参数）</sub></p>
</div>

### 多端响应式与深浅色主题适配
页面支持纯 CSS 原生响应式与深色模式自适应，在桌面宽屏、平板以及移动端上均可自如操作。

| 🖥️ 桌面端宽屏布局 | 🌙 原生深色模式适配 | 📱 移动端自适应交互 |
|:---:|:---:|:---:|
| <img src="docs/images/schedule-layout-desktop.png" alt="桌面端布局" width="280" style="border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" /> | <img src="docs/images/schedule-layout-dark.png" alt="深色模式布局" width="280" style="border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" /> | <img src="docs/images/schedule-layout-mobile.png" alt="移动端布局" width="280" style="border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" /> |

<details>
<summary><b>🔍 查看看板实时细节、Tab 菜单增强与信号取数口径（点击展开）</b></summary>

> [!TIP]
> **Tab 菜单交互增强**  
> `admin/modem/5g` 下的 12 个页面共用 LuCI 原生 Tab 菜单，插件在加载后执行纯 DOM 增强（`mt5700d/tabmenu.js`，不修改 LuCI 核心与主题，不拦截点击）：
> 1. **横向滚动记忆保持**：在横向滚动主题下，切换、返回或刷新页面后，菜单会自动将当前选中项居中滚入可视区，不再重置到首项；用户手动滚动的偏移量会在 `sessionStorage` 中按路径记忆。
> 2. **统一矢量 SVG 图标**：12 个页签各配一枚 24×24 线性图标（`stroke=currentColor` 随主题自适应着色，桌面端 16px / 窄屏 15px），语义精准对应业务功能。
> 3. **窄屏悬浮菜单**：宽度 ≤768px 时，12 个页签不再换行平铺，而是收进一个 38px 高的药丸触发器（显示当前页名与页签总数）；点击展开 300px 宽的气泡浮层，选中即跳转。点击外部、再点触发器或按 `Esc` 均可收起，`Tab` 键可依次进入浮层条目。桌面宽屏保持原生一排 Tab 不变，暗色模式下浮层沿用插件既有玻璃卡片配色。

> [!NOTE]
> **信号指标取数来源（`AT^HCSQ`，鼎桥手册 13.5）**  
> 不同制式的字段数与顺序各不相同，插件严格按手册字段表解析：
>
> | 制式 | value1 | value2 | value3 | value4 |
> |:---|:---|:---|:---|:---|
> | `^HCSQ: "NR",…` | 5G RSRP | 5G SINR | 5G RSRQ | — |
> | `^HCSQ: "LTE",…` | LTE RSSI | LTE RSRP | LTE **SINR** | LTE RSRQ |
> | `^HCSQ: "WCDMA",…` | RSSI | RSCP | Ec/Io | — |
> | `^HCSQ: "GSM",…` | RSSI | — | — | — |
>
> 各字段为编码值（RSRP：`-140 + n` dBm；SINR：`-20 + 0.2n` dB；RSRQ：`-19.5 + 0.5n` dB；RSSI/RSCP：`-121 + n` dBm），`255` 表示未知或不可测（显示为「—」）。信号优先取 `^MONSC` 的驻留小区读数，缺项（如 4G 下的 SINR）由 `^HCSQ` 精准补齐。

</details>

---

## 🚀 快速安装与上手

### 1. 确认系统架构与环境

在目标路由器终端运行以下命令，确定包管理器与目标架构：

```sh
# 查看系统架构与版本
. /etc/openwrt_release && echo "系统: $DISTRIB_ID $DISTRIB_RELEASE"

# 检查架构（根据输出决定下载 aarch64_cortex-a53、aarch64_generic 或 x86_64）
[ -f /etc/apk/arch ] && head -n1 /etc/apk/arch || grep OPENWRT_ARCH /etc/openwrt_release
```

> [!WARNING]
> 切勿使用 `apk --print-arch` 判定。该命令返回的是 apk 工具本身的编译预设值，包管理器实际依据的是 `/etc/apk/arch` 的首行输出。

### 2. 软件包下载与安装

前往 [GitHub Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 或 [CNB 镜像 Releases](https://cnb.cool/LianXia233/luci-app-mt5700/-/releases) 下载与架构匹配的安装包（主包 + 简体中文语言包）。每个 Release 同时附带 `SHA256SUMS`，建议先校验再安装：

```sh
# 下载主包、语言包与 SHA256SUMS 到同一目录后
grep -E 'luci-app-mt5700|luci-i18n' SHA256SUMS | sha256sum -c -

# -------------------------------------------------------------
# 【OpenWrt 25.x / ImmortalWrt SNAPSHOT / iStoreOS 25.x (apk)】
# -------------------------------------------------------------
apk add --allow-untrusted \
  ./<ARCH>-luci-app-mt5700-*.apk \
  ./<ARCH>-luci-i18n-mt5700-zh-cn-*.apk

# -------------------------------------------------------------
# 【OpenWrt 24.10 / ImmortalWrt 24.10 (opkg)】
# -------------------------------------------------------------
opkg install ./<ARCH>-luci-app-mt5700_*_<ARCH>.ipk
opkg install ./<ARCH>-luci-i18n-mt5700-zh-cn_*.ipk
```

> 安装包未由 OpenWrt 官方密钥签名，`--allow-untrusted` 只跳过签名校验，不校验内容完整性；请以 `SHA256SUMS` 为准。

### 3. 初始化配置与快速启动

安装完成后，执行以下指令完成初始参数提交与服务拉起：

```sh
# 1. 提交初始配置（默认启用自动探测 AT 串口）
uci set mt5700d.config.enabled='1'
uci set mt5700d.config.connection_type='SERIAL'
uci set mt5700d.config.serial_port='auto'
uci commit mt5700d

# 2. 启动服务并验证后端状态
service mt5700d restart
ubus call service list '{"name":"mt5700d"}'
```

进入 LuCI 侧边栏：**移动网络** → **5G 模组管理**（访问地址：`/cgi-bin/luci/admin/modem/5g`），即可开始使用。

> **界面语言**：简体中文为源语言，随包提供 `luci-i18n-mt5700-zh-cn` 语言包。共享组件（页面标题、卡片、按钮、表单标签、空态、下拉选项）已统一经 `mt5700.js` 的 `tr()` 调用 LuCI `_()`；新增语言只需在 `po/<lang>/` 建同名 `.po`，无需改 12 个视图。`tests/i18n-test.js` 校验 po 集合、菜单标题与组件接入。

<details>
<summary><b>📦 架构选型流程图、报错排查与稳定串口绑定（点击展开）</b></summary>

```mermaid
flowchart TD
    Start(["🔍 1. 查询目标设备架构<br/><code>cat /etc/apk/arch</code> 或 <code>grep OPENWRT_ARCH</code>"]) --> Check{"匹配固件声明架构"}

    Check -->|"aarch64_cortex-a53"| A53["📦 <b>aarch64_cortex-a53</b><br/>MediaTek MT7981 / MT7986 / Qualcommax 等"]
    Check -->|"aarch64_generic"| Generic["📦 <b>aarch64_generic</b><br/>armsr / 通用 ARMv8 / iStoreOS 25.x 等"]
    Check -->|"x86_64"| X86["📦 <b>x86_64</b><br/>PC 软路由 / PVE / ESXi / Hyper-V 虚拟机"]

    A53 --> PreCheck["💡 2. 安装前零风险预演验证<br/><code>apk add --simulate --allow-untrusted ./包名.apk</code>"]
    Generic --> PreCheck
    X86 --> PreCheck

    PreCheck --> Pass{"预演输出是否包含<br/><code>(1/1) Installing ?</code>"}
    Pass -->|"✅ 验证通过"| Install(["🚀 3. 正式执行安装<br/>服务自动注册并拉起启动"])
    Pass -->|"❌ 报错拦截"| ErrorFix["⚠️ 对照下方错误速查表修复<br/><i>(如架构声明不一致/语言包架构别名)</i>"]

    classDef check fill:#e0f2fe,stroke:#0284c7,stroke-width:1.5px,color:#0369a1;
    classDef pack fill:#f0fdf4,stroke:#16a34a,stroke-width:1.5px,color:#15803d;
    classDef pre fill:#fefce8,stroke:#ca8a04,stroke-width:1.5px,color:#a16207;
    classDef ok fill:#ecfdf5,stroke:#059669,stroke-width:1.5px,color:#047857;
    classDef err fill:#fef2f2,stroke:#dc2626,stroke-width:1.5px,color:#b91c1c;

    class Start,Check check;
    class A53,Generic,X86 pack;
    class PreCheck pre;
    class Install ok;
    class ErrorFix err;
```

#### 常见包校验报错速查

| 终端报错输出 | 根因剖析 | 推荐解决方案 |
|:---|:---|:---|
| `error: uninstallable arch: aarch64_cortex-a53` | 固件声明架构为 `aarch64_generic` | 改下 `aarch64_generic` 安装包；或执行：<br>`echo aarch64_cortex-a53 >> /etc/apk/arch` |
| `error: uninstallable arch: aarch64_generic` | 固件声明架构为 `aarch64_cortex-a53` | 重新下载并安装 `aarch64_cortex-a53` 安装包 |
| `error: uninstallable arch: all` | 语言包架构未被识别 | 实测 apk-tools 3.0.5+ 已兼容；若报错执行：<br>`echo all >> /etc/apk/arch` |
| `luci-app-mt5700 (no such package): required by...` | 语言包依赖主包，未合并安装 | 将主包与语言包放入同一条 `apk add` 或 `opkg install` 指令中 |

#### 串口路径固化建议 (`/dev/serial/by-id/`)

`/dev/ttyUSB*` 的编号由内核枚举顺序动态决定，模组插拔或换口后可能发生序号漂移（例如 PC UI 口从 `ttyUSB1` 漂移为 `ttyUSB2`）。推荐在服务配置中指定稳定的 `by-id` 链接：

```sh
# 查看当前硬件稳定链接与 AT 口（if12 对应 PC UI / AT 口）
ls -l /dev/serial/by-id/

# 固化配置到 UCI
uci set mt5700d.config.serial_port='/dev/serial/by-id/usb-XXXX:XXXX-if12-<序列号>'
uci commit mt5700d
service mt5700d restart
```

</details>

---

## 🏗️ 系统拓扑与数据链路

系统严格遵循分层解耦与职责单一原则，实现 **Web 响应毫秒级、串口调度独占互斥、数据转发硬件线速**：

```mermaid
flowchart TB
    subgraph UI ["🌐 表现层 · LuCI WebUI"]
        direction TB
        Views["<b>12 个现代化管理视图</b><br/>状态 / 扫频 / 锁频 / 短信 / 终端 / 拨号 / 模组..."]
        RPCClient["<b>前端通信总线 (rpc.js)</b><br/><code>L.rpc.declare</code> · 轮询 <code>events(since)</code>"]
        Views <--> RPCClient
    end

    subgraph OS ["⚡ 中介与代理层 · OpenWrt rpcd / ucode"]
        direction TB
        RPCD["<b>系统 RPC 守护 (rpcd)</b><br/>Session 鉴权 · ACL 权限控制"]
        Ucode["<b>ucode 业务代理 (mt5700.uc)</b><br/>端口监听预检 (/proc/net/tcp) · 熔断保护"]
        SysfsDirect["<b>零 AT 旁路读取 (sysfs)</b><br/>实时速率 (netrate) · USB 设备发现"]
        RPCD <--> Ucode
        Ucode -.->|"sysfs 直读 (零串口开销)"| SysfsDirect
    end

    subgraph CORE ["🦀 核心守护层 · Rust / Tokio 后端 (mt5700d)"]
        direction TB
        RpcServer["<b>本地 RPC 服务 (127.0.0.1:8765)</b><br/>newline-JSON 内部通讯 · 任务分发与状态同步"]

        subgraph Modules ["业务引擎与状态机"]
            direction LR
            Dialer["<b>自动拨号对账</b><br/>双判决 + 指数退避"]
            StateCache["<b>状态预热缓存</b><br/>射频/温度毫秒级返回"]
            SmsEngine["<b>短信与安全存储</b><br/>PDU解码 + ChaCha20归档"]
            Notifier["<b>多通道告警</b><br/>企微 Webhook + QQ 机器人"]
            UsageTracker["<b>流量统计</b><br/>sysfs/DS双源 + 月度清零"]
            Scheduler["<b>定时锁频</b><br/>频段/EARFCN/PCI 轮转"]
        end

        subgraph Queue ["AT 调度与独占控制"]
            PriLock["<b>优先级独占调度器 (PriLock)</b><br/>Sms > High > Normal > Low > Background<br/><i>单通道互斥持锁，杜绝多进程抢占 TTY 冲突</i>"]
            URCHub["<b>URC 事件分发总线</b><br/>新短信 (+CMTI) / 来电 (RING) / 存储满"]
        end

        RpcServer <--> Modules
        Modules --> PriLock
        URCHub -.->|"事件上报"| RpcServer
    end

    subgraph HARDWARE ["📡 硬件与蜂窝链路 · MT5700M 5G 模组"]
        direction TB
        ModemAT["<b>PCUI 串口通道</b><br/><code>/dev/serial/by-id/*</code> (<code>/dev/ttyUSB*</code>)<br/><b>AT 控制面 (独占互斥)</b>"]
        ModemBaseband["<b>5G 基带核心</b><br/>SA / NSA 驻网 · 载波聚合 (CA) · PDP 激活"]
        ModemNet["<b>USB 虚拟网卡</b><br/>NDIS / NCM / RNDIS 驱动<br/><b>网络数据面 (高速吞吐)</b>"]
        ModemAT <--> ModemBaseband
        ModemBaseband <--> ModemNet
    end

    subgraph NETWORK ["🛡️ 路由器网络面 · Linux / OpenWrt 协议栈"]
        direction TB
        Netifd["<b>网络接口管理 (netifd)</b><br/><code>MT5700M</code> (IPv4) / <code>MT5700Mv6</code> (IPv6)<br/>自动 DHCP 客户端 · DNS 动态下发"]
        Hooks["<b>自愈拉起钩子</b><br/><code>on-uplink.sh</code> · <code>init.d</code> · <code>hotplug.d</code>"]
        Firewall["<b>防火墙与 NAT (fw4 / nftables)</b><br/><code>wan</code> 区域绑定 · <code>lan ➔ wan</code> 伪装转发"]
        Clients["<b>局域网终端</b><br/>LAN 有线客户端 / Wi-Fi 无线终端"]

        Hooks -->|"触发拉起 (ifup)"| Netifd
        Netifd --> Firewall
        Firewall <--> Clients
    end

    %% 控制面与数据面跨层链路
    RPCClient -->|"① JSON-RPC 鉴权请求"| RPCD
    Ucode -->|"② 本地 TCP Socket (nc 管道)"| RpcServer
    PriLock <-->|"③ 独占调度 AT 事务"| ModemAT
    ModemAT -.->|"④ 异步 URC 上报"| URCHub
    Dialer -->|"⑤ 拨号就绪回调"| Hooks
    ModemNet <-->|"⑥ 数据面 IP 报文"| Netifd
    SysfsDirect -.->|"⑦ 真实速率采样"| ModemNet

    classDef ui fill:#e0f2fe,stroke:#0284c7,stroke-width:1.5px,color:#0369a1;
    classDef os fill:#f3e8ff,stroke:#7e22ce,stroke-width:1.5px,color:#6b21a8;
    classDef rust fill:#ffedd5,stroke:#ea580c,stroke-width:1.5px,color:#c2410c;
    classDef hw fill:#ecfdf5,stroke:#059669,stroke-width:1.5px,color:#047857;
    classDef net fill:#f1f5f9,stroke:#475569,stroke-width:1.5px,color:#334155;
    classDef sub fill:#ffffff,stroke:#cbd5e1,stroke-width:1px,color:#1e293b;

    class Views,RPCClient ui;
    class RPCD,Ucode,SysfsDirect os;
    class RpcServer,PriLock,URCHub rust;
    class Dialer,StateCache,SmsEngine,Notifier,UsageTracker,Scheduler sub;
    class ModemAT,ModemBaseband,ModemNet hw;
    class Netifd,Hooks,Firewall,Clients net;
```

<details>
<summary><b>🖼️ 查看高精度全景架构海报（点击展开）</b></summary>

<div align="center">
  <img src="docs/topology.png" alt="系统拓扑与数据链路：LuCI WebUI 经 rpcd ucode 代理至 Rust/Tokio 常驻后端，独占管控 MT5700M 模组" width="880" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-top: 10px;" />
</div>

</details>

### ⚡ 核心设计原则与通信机制

1. **表现层 (LuCI WebUI)**：基于原生 ES6 与 LuCI 组件开发，纯 DOM / 矢量 SVG 驱动，不依赖重型框架；通过 `rpc.js` 统一封装 JSON-RPC 调用与 `events(since)` 事件轮询。
2. **中间通信层 (rpcd ucode 代理)**：挂载至系统 rpcd 发布 `luci.mt5700.*` 接口。内置 `/proc/net/tcp` 回环端口预检（零子进程、毫秒级快速失败）与 15s 熔断保护；流量速率 (`netrate`) 与硬件识别走 **sysfs 直读旁路**，全程不下发 AT，零串口开销。
3. **核心守护层 (Rust/Tokio 常驻后端)**：`/usr/bin/mt5700d` 单实例常驻（内存仅数十 KiB），监听 `127.0.0.1:8765` newline-JSON 协议。通过 `StateCache` 异步预热只读状态，RPC 查询毫秒级返回，避免前端并发查询阻塞串口。
4. **模组控制层 (AT 事务独占持锁)**：所有 AT 交互统一经过 `PriLock` 优先级队列调度，独占持有模组 PCUI 串口，彻底杜绝多进程抢占 TTY 引起的数据截断与指令挂死。

#### AT 事务优先级调度等级 (PriLock)

| 优先级等级 | 业务场景 | 调度策略与典型命令 |
|:---|:---|:---|
| **P0 · Sms (最高)** | 短信发送、实时读取、批量删除 | **抢占最高优先级**，独占持锁完成整段 PDU 交互，避免短信长指令被普通查询打断 |
| **P1 · High (优先)** | Web AT 终端交互、紧急故障恢复 | 用户主动调试与应急自愈操作，享受次高通道调度 |
| **P2 · Normal (常规)** | 射频状态查询、网络模式配置、SIM 切换 | `AT^HCSQ`、`AT^MONSC`、`AT+CPIN?` 等标准业务读写 |
| **P3 · Low (低优先)** | 芯片温度监控、周期巡检采样 | `AT^CHIPTEMP?` 等周期性低频监控任务 |
| **P4 · Background (后台)** | 全网邻区扫频、深度频段分析 | `AT^FREQLOCK` 扫描等耗时长达数秒至数十秒的重型任务，不阻塞高优先业务 |

---

### 🔄 自动拨号与全链路协同机制

数据面连通需经历从底层硬件枚举、AT 握手到操作系统网络协议栈的逐级对齐：

```mermaid
sequenceDiagram
    autonumber
    actor Terminal as 📱 局域网终端 (LAN / Wi-Fi)
    participant FW as 🛡️ 防火墙 (fw4)
    participant Netifd as 🌐 网络管理 (netifd)
    participant InitD as ⚙️ 接入自愈 (init.d / hotplug)
    participant Rust as 🦀 常驻后端 (Rust / Tokio)
    participant Modem as 📡 MT5700M 5G 模组

    Note over Modem,InitD: 【阶段 1 · 硬件枚举】模组接入与 USB 总线识别
    Modem->>InitD: USB 硬件枚举就绪 (VID 3466 / MT5700M)
    InitD-->>Rust: hotplug.d/usb 捕获事件，准备联动

    Note over Rust,Modem: 【阶段 2 · 状态对齐】PCUI 串口持锁与自动拨号对齐
    Rust->>Modem: 自动探测 PCUI 端口并获取 PriLock 互斥锁
    Rust->>Modem: 下发 AT^SETAUTODIAL=1,1 (对齐拨号开关与工作模式)
    Modem-->>Rust: 返回 OK (基站注册就绪，蜂窝网驻网成功)

    rect rgb(240, 248, 255)
    Note over Rust,Modem: 【阶段 3 · 双判决对账】联合健康校验 (5 分钟定时巡检 / 失败指数退避)
    Rust->>Modem: 联合轮询 AT^NDISSTATQRY? 与 AT+CGACT?
    Modem-->>Rust: 确认 NDIS 与 PDP 数据承载双双处于激活状态
    end

    Note over Rust,InitD: 【阶段 4 · 链路拉起】承载接口纳管与防火墙对齐
    Rust->>InitD: 触发完成回调: /usr/libexec/mt5700d/on-uplink.sh
    InitD->>Netifd: 检查并自动创建 MT5700M / MT5700Mv6 接口 (proto=dhcp)
    InitD->>Netifd: 下发运营商 / 指定 DNS 伺服配置
    InitD->>FW: 将承载接口登记至 wan 区域并热重载 fw4 (NAT)
    InitD->>Netifd: 调用 ifup 拉起网络承载

    Note over Netifd,Terminal: 【阶段 5 · 寻址连通】DHCP 握手与外网全链路打通
    Netifd->>Modem: USB 虚拟网卡 (NDIS) 发起 DHCP 请求
    Modem-->>Netifd: 分配 IPv4 / IPv6 公网地址、网关与默认路由
    FW-->>Terminal: NAT 伪装规则生效，局域网终端顺畅访问互联网
```

<details>
<summary><b>🖼️ 查看高精度时序流程海报（点击展开）</b></summary>

<div align="center">
  <img src="docs/auto-dial-sequence.png" alt="MT5700M 5G 模组自动拨号与网络接入时序图" width="880" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-top: 10px;" />
</div>

</details>

#### 各环节协同机制与容灾方案

| 协作环节 | 负责组件 | 运行机制与容灾方案 |
|:---|:---|:---|
| **拨号开关与方式对齐** | Rust 后端 | 建立连接后强制核验；未达成执行指数退避重试（0/5/15/30/60/120s），每 5 分钟定时巡检对账 |
| **可用性双判决** | Rust 后端 | 联合校验 `AT^NDISSTATQRY?` 与 `AT+CGACT?` 双重指标，杜绝假死虚挂 |
| **承载接口拉起** | init.d + hotplug | 18 次 × 10s 间隔轮询保护；`hotplug.d/iface` 与 `hotplug.d/usb` 动态补发 `ifup` |
| **承载接口选择** | init.d | `iface_v4`/`iface_v6` 默认自动扫描：已挂在模组网口上的接口优先复用；支持手动指定 |
| **缺失接口补全** | init.d | 未找到可用接口且检测到硬件网卡时，自动创建 `MT5700M` 与 `MT5700Mv6` 接口并设为 `proto=dhcp` |
| **防火墙区域绑定** | init.d | 接口创建后自动登记至 `wan` 区域并重载 `fw4`，打通 `lan → wan` 的 NAT 转发规则 |

---

## 📊 功能矩阵 (12 大独立管理页面)

插件所有视图源码位于 `htdocs/luci-static/resources/view/mt5700d/`，各页面能力明细如下：

| 业务领域 | 页面名称 | 访问路径 | 核心能力说明 |
|:---|:---|:---|:---|
| 📡 **射频与基站** | **网络状态** | `admin/modem/5g/status` | 4 联射频仪表盘（RSRP / RSRQ / SINR / 综合信号评分）；**实时双 Y 轴趋势图**（支持质量底色、图例开关、缺口断点）；载波聚合（CA）频谱图；芯片 12 路微热力矩阵；MCS 动态 I/Q 星座图；**内核级流量火花线与设备侧使用量累计**（重启不丢失、定时清零）；SIM 签约速率（`^DSAMBR`）与 QoS 等级（5QI / QCI，`+C5GQOSRDP`）；双栈地址与驻网制式。 |
| | **网络设置** | `admin/modem/5g/network` | 5G / 4G 网络模式优先选择、SA / NSA 组网模式指定；APN 接入点分组配置（预设公众卡与物联网卡，精准剔除失效老 APN）。 |
| | **全网扫频** | `admin/modem/5g/scan` | 全频段或指定频段邻区基站快速扫描，物理层小区参数导出；扫频期间自动优雅暂离蜂窝数据并在完成后无缝复原。 |
| | **定时锁频** | `admin/modem/5g/schedule` | 支持锁定指定频段（Band）、频点（EARFCN）与基站物理小区 ID（PCI）；支持按日间/夜间时间策略自动轮转执行。 |
| 🌐 **数据与链路** | **拨号设置** | `admin/modem/5g/dial` | USB NDIS 拨号与转以太网口模式无缝切换；承载网络链路状态守护与自动对账。 |
| | **模组设置** | `admin/modem/5g/modem` | 模组核心硬件元数据查询（sysfs 零 AT 识别 USB 协商速率）；SIM 卡槽切换、热插拔与 PIN 码管理；载波聚合 / DSS / VoNR 射频特性控制；软硬件复位重启与出厂重置。 |
| | **模组升级** | `admin/modem/5g/firmware` | 模组新固件远程推送检测；本地固件升级包安全校验与刷写。 |
| 💬 **消息与运维** | **短信中心** | `admin/modem/5g/sms` | 支持 PDU / Text 短信收发与长短信自动合并分片；**聊天式 IM 会话界面**（双方头像、时间分隔、宽度随文收缩）；**发出记录本地 ChaCha20 加密归档**（路由闪存 2 MiB 循环配额，解决模组不写已发槽位的限制）；时间戳与 NTP 精确对齐；批量降序安全删除。 |
| | **短信设置** | `admin/modem/5g/sms-settings` | 自定义短信中心号码（SMSC，写入回读强校验）；存储介质切换（ME 模组 FLASH / SM SIM 卡）；USSD 快捷查询（话费/流量代码）。 |
| | **AT 调试终端** | `admin/modem/5g/terminal` | Web 原生交互式控制台，支持常用 AT 指令自动补全、历史回溯、原语调试与脱敏复制。 |
| | **运行日志** | `admin/modem/5g/log` | 后端内存环形缓冲 + 插件自有日志文件 + 系统 syslog 三源统一入口；日志按 **21 个业务域细分**（AT 通道 / 主动上报 / 拨号承载 / 接口防火墙 / 信号射频 / SIM / 短信 / 通话 / 通知推送 / 扫频 / 锁频 / 模组升级 / 流量 / 时间，以及运行时 / 配置 / RPC / 串口 / 任务 / 存储 / 其他），**类别由后端定类**而非前端拿正则猜；模组业务痕迹不再刷 syslog，只落内存环形缓冲与插件文件（`/tmp/mt5700d/plugin.log`，有界裁剪），仅 `ERR` 破例外发以便 `logread` 直接看到硬故障；支持关键词过滤与一键筛选「错误+警告」；通知记录留痕与企业微信/QQ 告警流追踪。 |
| | **服务配置** | `admin/modem/5g/config` | 常驻后端参数调优、串口绑定路径选择、自动拨号守护策略、退避重试阈值设置与自愈巡检总控。 |

> 📖 **进阶文档**：
> - [短信功能使用文档 (docs/sms-usage.md)](docs/sms-usage.md) —— 界面操作手册、关闭短信副作用、常见提示处置与验收清单。
> - [短信链路协议与命令参考 (docs/sms-at-protocol.md)](docs/sms-at-protocol.md) —— 3GPP PDU 编解码、三条链路的 AT 命令序列、三层超时预算与实机报文核对。

---

## 🎯 数据可信度与取数规范

本项目贯彻一条核心准则：**界面上的每一个数字，必须能无缝追溯至模组射频寄存器或内核原生计数器的真实读数**。

> [!IMPORTANT]
> **四大取数铁律**
> 1. **取不到如实说**：字段未上报或不可测时显示「—」或「未上报」，绝不使用 `Math.random()` 伪造，亦不使用其他参数勉强拼凑；
> 2. **缺口不连线**：信号趋势图某周期未能采集到有效读数时记录 `null`，绘图严格按断点断开，杜绝绘制伪造的平滑假线；
> 3. **实时速率精准计算**：由相邻两次内核统计计数器的真实增量除以物理时间差换算得出，绝不用累计值随意均摊；
> 4. **链路全透明可核对**：取数集中于标准 3GPP AT 命令与 sysfs 节点，任何维护者均可在路由终端自行复现验证。

### 核心指标取数对照表

| 监控项 | 取数来源 / 节点 | 备注与机制 |
|:---|:---|:---|
| RSRP / RSRQ / SINR | `AT^HCSQ`（手册 13.5） | 严格按制式解析字段表，`255` 编码值如实判定为不可测 |
| 驻留小区 / 频段 / PCI | `AT^MONSC` · `AT^HFREQINFO?` | 优先取 `^MONSC` 驻留小区，缺项由 `^HCSQ` 补齐 |
| 实时速率 / 本次使用量 | WAN 区域模组物理网口 `sysfs` 计数器，或模组 `AT^DSFLOWQRY` | 来源可手动切换；默认走物理网卡，**全程不下发 AT**，零串口负担 |
| 签约速率 (AMBR) | `AT^DSAMBR=<cid>`（手册 16.17） | 4G/5G 均可用；取不到时以 `AT+C5GQOSRDP` 的 Session-AMBR 兜底 |
| QoS 等级 (5QI / QCI) | `AT+C5GQOSRDP=<数据 cid>`（3GPP TS 27.007） | 只读数据承载的等级字段并校验应答 CID；`0`（由网络选择）按未上报显示 |
| SIM 状态 / IMSI / ICCID | `AT+CPIN?` / `AT+CIMI` / `AT^ICCID?` | 状态机分层核对，防止误报就绪 |
| 芯片温度矩阵 | `AT^CHIPTEMP?`（手册 17.1.1） | 12 路硬件测温点逐路定级，仪表盘以**最高通道结温**评定整体散热 |
| 发射功率 | `AT^NTXPOWER?`（NR）/ `AT^TXPOWER?`（LTE） | NR 模式下 `AT^TXPOWER?` 恒报错属模组硬件正常行为 |

#### 流量统计口径与来源开关

累计用量与实时速率共用同一套口径：**只统计 WAN 防火墙区域**，自动识别模组创建的
物理网口，不写死任何网卡名。显式排除 `br-lan` 及其 VLAN 子接口、`lo` 与 LAN 区域网卡。
识别顺序为：WAN 区域成员 ∩ USB 模组网口 → WAN 区域内其它物理网口 → 候选全无时
「非 LAN 归属的 USB 网卡」；全部取不到则停止统计，累计值保留，**绝不回退 LAN 侧计数器**。

来源由 `mt5700d.config.usage_source` 控制，也可在「网络状态 → 本次使用量」里切换：

| 取值 | 数据源 | 粒度 / 代价 |
|:---|:---|:---|
| `netdev`（默认） | WAN 区域模组物理网口的 `/sys/class/net/<dev>/statistics/{rx,tx}_bytes` | 1 秒，零 AT 负担 |
| `modem` | 模组 `AT^DSFLOWQRY` 的 DS 累计收发字节（手册 16.12，16 位十六进制） | 2 秒（复用既有状态缓存），速率为 2 秒粒度 |

切换会写入 UCI 并热更新；统计器按 `device` 标签变化自动重新基线，累计值保留。
`netrate` 在 `modem` 来源下转发到 Rust 后端取同一份 DS 累计值，保证速率与使用量同口径。
「清零」只重置插件侧累计与基线，不会下发 `AT^DSFLOWCLR` 清除模组全局计数。

DNS 下发同样按「USB 模组网口 + WAN 区域」自动反查承载接口：IPv4 DNS 下发给直接绑定
模组网口的接口，IPv6 DNS 下发给经 `@别名` 引用它们的接口，不再绑定具体接口名称。

---

## 🔔 事件通知与远程告警

系统支持将模组硬件事件与链路状态实时外发至远程通道，支持**企业微信机器人**与 **QQ 机器人（官方 API v2）**。

### 事件类型与投递机制

| 事件类型 | 触发源 | 投递时效 | 机制说明 |
|:---|:---|:---|:---|
| **新短信到达** | 模组 URC `+CMTI:` | **即时直发** | 自动提取短信中心时间戳，长短信合并完成后即刻推送。 |
| **电话呼入** | 模组 URC `RING` | **即时直发** | 上报呼叫方号码与事件时刻。 |
| **短信存储告警** | 模组 URC `^SMMEMFULL` | **即时直发** | 存储区达到上限时告警，提醒清理避免漏收。 |
| **信号突变与网络切换** | 后端巡检（`notify_poll_*`） | **受限直发** | 仅在指定巡检时段生效；受 `notify_signal_min_interval` 最小间隔保护。 |
| **定时状态简报** | 定时器（`notify_timer_interval`） | **周期心跳** | 默认 10 分钟一次，上报当前网络质量快照与短信存储占用。 |

### QQ 机器人富文本卡片与防刷屏机制

- **Markdown 卡片模板**：推送新短信、巡检报告与切换提醒时，自动组装为包含二级标题、引用区与状态对比表的 Markdown 富文本卡片；
- **内嵌跳转键盘**：富文本底部可附带「打开管理页」一键跳转按钮（自动识别 `network.lan.ipaddr` 填充）；
- **二级防刷屏保护**：
  1. **信号通知最小间隔 (`notify_signal_min_interval`)**：默认 60 分钟，基线动态保留，彻底解决模组在 4G/5G 覆盖边缘来回跳水导致的频繁轰炸；
  2. **平台通道节流 (`qq_max_per_minute`)**：默认 10 条/分钟，超额消息进入滑动窗口排队发送，避免撞上 QQ 官方频控封禁。

---

## 🛠️ UCI 配置参考 (`/etc/config/mt5700d`)

以下为系统核心配置段的典型参考：

```ini
config mt5700d 'config'
    option enabled '1'                        # 服务总开关：1=启用，0=禁用
    option connection_type 'SERIAL'           # 通信模式：SERIAL(串口) / TCP(网络调试回环)
    option serial_port 'auto'                 # 串口绑定：auto(自动探测) / /dev/serial/by-id/* / /dev/ttyUSB*
    option autodial_enable '1'                # 自动拨号守护总控：1=启用，0=关闭
    option autodial_mode '1'                  # 拨号工作模式：1=USB网卡模式，2=转以太网口模式
    option iface_v4 'auto'                    # IPv4 承载接口：auto=自动复用/创建 / 接口名
    option iface_v6 'auto'                    # IPv6 承载接口：auto=跟随 IPv4 / none / 接口名
    option manage_interface '1'               # 接口纳管：1=缺失时自动建接口与绑定防火墙，0=纯手动
    option cellscan_timeout '180'             # 扫频超时保护阈值(秒)

    # --- 远程事件通知配置 ---
    option notify_enabled '1'                 # 事件通知总开关
    option notify_timer_interval '10'         # 定时状态报告推送周期(分钟，默认 10)
    option notify_signal_min_interval '60'    # 信号变化通知最小间隔(分钟，防刷屏保护)

    # 企业微信通道
    option wechat_enabled '0'                 # 企业微信推送开关
    option wechat_webhook ''                  # 企业微信群机器人 Webhook 地址

    # QQ 官方机器人通道 (API v2)
    option qq_enabled '0'                     # QQ 机器人推送开关
    option qq_app_id ''                       # 开放平台 AppID
    option qq_app_secret ''                   # 开放平台 AppSecret
    option qq_target_type 'c2c'               # 目标类型：c2c(单聊) / group(群聊) / channel(频道)
    option qq_target_id ''                    # 接收者 OpenID
    option qq_msg_format 'auto'               # 消息格式：auto(Markdown优先) / text
    option qq_keyboard_enabled '1'            # 是否附带内嵌跳转键盘
    option qq_max_per_minute '10'             # 官方主动消息每分钟节流阈值
```

---

## 📋 OpenWrt 版本兼容性与架构支持

| OpenWrt 版本 | 对应分支 | 包管理器 | 产物格式 | 支持状态 | 运行说明 |
|:---|:---|:---:|:---:|:---:|:---|
| **25.12.x** | SNAPSHOT (25.x) | `apk` | `.apk` | ✅ **官方 CI 构建发布** | 覆盖三档硬件架构；iStoreOS 25.x 完美兼容 |
| **24.10.x** | `openwrt-24.10` | `opkg` | `.ipk` | ✅ **官方 CI 构建发布** | 长期支持版，当前生产主力推荐 |
| **23.05.x** | `openwrt-23.05` | `opkg` | `.ipk` | ⚠️ 依赖满足，建议验证 | `luci-base` 自本代起内置 `rpcd-mod-ucode`，具备加载环境 |
| ≤ 22.03 | `openwrt-22.03` 及更早 | `opkg` | `.ipk` | ❌ **开箱不可用** | 默认缺少 `rpcd-mod-ucode` 运行环境，无法注册 RPC 接口 |

### 硬件架构覆盖

- **`x86_64`**：软路由、工控机、PVE / ESXi / Hyper-V 虚拟机；
- **`aarch64_cortex-a53`**：MediaTek Filogic (MT7981 / MT7986 / MT7988)、Qualcommax 等固件；
- **`aarch64_generic`**：Arm SystemReady (armsr / armv8)、通用 64 位 ARM 路由及 iStoreOS。

---

## 🧪 本地测试与质量保证

仓库配备了完善的前后端零依赖静态单测与端到端模拟用例，提交代码前可按以下命令进行验证：

```sh
# 1. 静态语法与代码规范检查 (无外部依赖，秒级完成)
node tests/static-check.js
for f in tests/*-test.js; do node "$f" || exit 1; done

# 2. Rust 后端编译、单元测试与 Clippy（生产段与测试段都必须 0 告警）
(cd src/rust && cargo test --locked && cargo clippy --all-targets -- -D warnings)

# 3. 模组与 RPC 全链路端到端模拟测试 (mock-modem + 真实后端 + RPC 通信)
sh tests/mock-modem/run-e2e.sh
```

CI 门禁与本地一致：`static-check` → 零依赖 Node 单测 → Shell 语法/shellcheck（error 级）→ `cargo test` → `cargo clippy -D warnings` → mock 模组 e2e。

---

## ❓ 常见问题排错 (FAQ)

<details>
<summary><b>1. 为什么安装后打开页面提示「后端未就绪 / 连接被拒绝」？</b></summary>

请按以下顺序排查：
1. 检查后端服务是否正常运行：`service mt5700d status` 或 `ubus call service list '{"name":"mt5700d"}'`；
2. 检查系统中是否有 busybox 的 `nc` 命令：`which nc`（部分精简固件可能裁剪了 `nc` applet，导致 ucode 无法通过 socket 连接 Rust 后端）；
3. 检查串口是否被其他进程（如 QModem、minicom、chat 等）独占抢占；
4. 确认系统是否存在 `rpcd-mod-ucode` 插件（OpenWrt 23.05+ 默认提供）。

</details>

<details>
<summary><b>2. 为什么提示「有 IP 地址却无法上网」？</b></summary>

1. 检查防火墙 NAT 区域：在终端执行 `uci show firewall | grep 'network=.*MT5700M'`，确认 `MT5700M` 承载接口已正确登记入 `wan` 防火墙区域；
2. 执行一键接口与防火墙自愈脚本：`/etc/init.d/mt5700d ensure_interfaces`；
3. 查看当前 nftables 规则是否包含模组接口：`nft list chain inet fw4 srcnat`。

</details>

<details>
<summary><b>3. 为什么与 QModem 互不兼容？</b></summary>

MT5700M 模组只有一个主控制 AT 串口（PC UI）。QModem 与本插件均需要独占该串口下发业务控制指令。若两者同时常驻，会造成指令交叉穿插、回执匹配错位（如将短消息应答当成拨号应答）甚至引起模组通信通道死锁。使用本插件无需配合 QModem。

</details>

---

## 📄 许可证与开源声明

本项目遵循 **GNU General Public License v3.0 (GPL-3.0-only)** 开源协议发布，完整条款见根目录 [`LICENSE`](LICENSE)。

### 角色素材与知识产权声明

本项目界面引用了**两部不同作品**的角色形象，均不在 GPL-3.0-only 授权范围内：

- **英雄区头像**（`mascot.png`）：《异环》（NTE / Neverness to Everness）的「薄荷」（Mint），
  著作权归苏州幻塔网络科技有限公司（Hotta Studio）/ 完美世界游戏。
- **PC / 移动端背景**（`bg/character-{pc,mobile}-{dark,light}.webp`）：《蔚蓝档案》（Blue Archive）
  的「阿罗娜 / 彩奈」（Arona，浅色）与「普拉娜」（Plana，深色），
  权利标注 `© NEXON Games Co., Ltd. & Yostar, Inc.`（国服含上海悠星网络科技有限公司）。

- **授权状态**：本仓库尚未取得权利人的书面许可，也未留存可核验的官方开放许可；项目开源或非商业使用的描述均不构成权利人的授权。
- **保留决定与分发风险**：按维护者决定，上述素材继续保留在界面与安装包内作装饰用途。这不是权利人的授权，也不能仅凭素材与 GPL 代码同包分发就断言其属于 GPLv3 所称的独立聚合。安装包会附带 `ARTWORK-NOTICE.txt` 说明权利归属；若权利人提出异议，将移除或替换。
- **完整清单**：逐文件尺寸与 SHA-256 指纹、角色识别依据、图稿性质、授权状态与处置要求见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 第 2 节。背景图为二次创作插画，绘师与原始出处未在仓库内留存，角色身份识别未经权利人确认。

### 第三方软件依赖与许可证

Rust 后端依赖各自保留上游许可证。正式 APK / IPK 会附带逐项依赖清单及许可证全文，安装后位于 `/usr/share/licenses/luci-app-mt5700/RUST-DEPENDENCIES.md`；同一目录还包含项目 GPL-3.0 全文、角色素材声明 `ARTWORK-NOTICE.txt`，以及 Mozilla CA 根证书数据所用的 `CDLA-Permissive-2.0` 完整协议。项目代码的 GPL-3.0-only 不会覆盖第三方依赖或角色素材。更多细节见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

### 商标与指称使用

`OpenWrt`、`ImmortalWrt`、`LuCI`、`MT5700M` 等商标与标识均归各自权利人所有。本仓库中对相关名称的引用仅用于客观指示运行平台、系统组件及硬件型号，不代表任何形式的官方背书或授权合作。

### 项目版权与维护

项目代码版权归 **LianXia233** 所有。

```text
Copyright (C) 2026 LianXia233
SPDX-License-Identifier: GPL-3.0-only
```

本项目代码依据 **GNU General Public License v3.0 only** 授权。你可以在许可证规定的范围内使用、研究、修改和再分发本项目；具体权利与义务以根目录 [LICENSE](LICENSE) 的完整条款为准。请勿将本项目的 GPL 授权误解为对第三方角色素材、商标或其他独立资产的授权。

<div align="center">

**LianXia233 · 开发与维护**

[GitHub](https://github.com/LianXia233) · [项目仓库](https://github.com/LianXia233/luci-app-mt5700) · [提交 Issue](https://github.com/LianXia233/luci-app-mt5700/issues)

</div>
