# AT WebServer · MT5700M 5G 模组管理

> **OpenWrt LuCI 插件** · 前端 12 页 + Rust 后端 **单包交付**  
> 包名 `luci-app-mt5700` · 服务/UCI 段 `at-webserver` · 当前版本 **v1.5.0**

| | |
|:--|:--|
| **架构** | LuCI → rpcd ucode → Rust (tokio) → 模组 AT |
| **默认连接** | PCUI 串口 `/dev/ttyUSB1`（网络 TCP 备用） |
| **打包** | 单包内含页面 + `/usr/bin/at-webserver-rust` |
| **云编译** | GitHub Actions · x86_64 / aarch64 · apk + ipk |
| **发布** | 每次编译成功自动上传 [Release](https://github.com/LianXia233/luci-app-mt5700/releases) |

---

## 目录

- [快速安装](#快速安装)
- [功能一览](#功能一览)
- [架构](#架构)
- [项目结构](#项目结构)
- [云编译与发布](#云编译与发布)
- [本地开发与测试](#本地开发与测试)
- [UCI 配置](#uci-配置)
- [Rust 后端](#rust-后端)

---

## 快速安装

从 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载**与目标架构匹配**的主包（约 1.2MB，已含后端）。

### OpenWrt 24.10+（apk）

```sh
# 以 aarch64_cortex-a53 为例
apk add --allow-untrusted \
  ./aarch64_cortex-a53-luci-app-mt5700-1.2.0-r1.apk \
  ./aarch64_cortex-a53-luci-i18n-mt5700-zh-cn-*.apk
```

### OpenWrt 23.05（opkg / ipk）

```sh
opkg install ./aarch64_cortex-a53-luci-app-mt5700_1.2.0_aarch64_cortex-a53.ipk
opkg install ./aarch64_cortex-a53-luci-i18n-mt5700-zh-cn_*.ipk
```

### 启动与确认

```sh
uci set at-webserver.config.enabled=1
uci set at-webserver.config.connection_type=SERIAL   # 默认 PCUI
uci set at-webserver.config.serial_port=auto         # 优先探测 ttyUSB1
uci commit at-webserver
service at-webserver restart

# 单包自检：后端二进制应存在
ls -l /usr/bin/at-webserver-rust
```

浏览器登录 LuCI → **移动网络 → 5G 模组管理**（路径 `admin/modem/5g`），即可看到 12 个页面。

> **为何必须有后端进程？** 串口/`AT` 通道、定时锁频、扫频、企业微信推送都必须常驻，浏览器无法完成。  
> 「一个安装包」= 前后端合一（v1.1.0+）；不是「一个静态 HTML」。

> **v1.5.0 说明**：UI 全面升级为「Modern Dimensional Layering」v2（圆形信号仪表、
> 卡片分层、统一按钮/开关样式），拨号设置页接入暂存式「保存并应用」，
> 并修复短信乱码、SINR / MCS 数据源错误与 Aurora 主题开关串扰。
> 详见 [CHANGELOG](CHANGELOG.md) 的 `[1.5.0]` 段。

> **v1.4.1 说明**：v1.4.0 的 UI 重构把多个页面降级为骨架、且 LuCI 依赖指令被压缩器剥离
> （运行时 `Mt5700 is not defined`）。v1.4.1 以 v1.3.4（`971008ca`）为基准逐页恢复功能，
> 同时保留 v1.4.x 的新 UI 视觉。详见 [CHANGELOG](CHANGELOG.md) 的 `[1.4.1]` 段。

### 保存配置

配置修改采用**暂存式「保存并应用」**，与 LuCI 原生行为一致：

- 「服务配置」页：修改任一控件即标记「未保存更改」，点击「保存并应用」后依次执行
  `uci.changes()` → `uci.save()` → `uci.apply()`；若本来就没有待应用的变更
  （rpcd 返回 ubus 状态码 5 / NO_DATA），视为已生效，提示「无待处理的变更」
  而不是误报失败；应用成功后自动重载 at-webserver 服务并回查真实进程状态。
- 「拨号设置」页：所有写操作（自动拨号、APN、拨号方式、USB 端口模式、网口模式、
  后置路由、DMZ、PDP 上下文）先暂存，页面底部粘性条提供「撤销更改 / 应用更改」，
  仅在确认应用后配置才真正写入并生效。

### 网络接口没有 IP / 无法联网

模组显示在线但「网络 → 接口」里 `MT5700M` 拿不到地址，通常是下面两处之一：

```sh
# 1) 接口是否开机自启？autostart 必须为 true
ifstatus MT5700M | grep -E '"up"|"autostart"'
uci show network.MT5700M | grep auto      # 期望 auto='1'

# 2) 模组是否开了自动拨号？不开则网口不会下发 DHCP，接口必然没有地址
printf 'AT^SETAUTODIAL?\r\n' | nc 127.0.0.1 8765
```

自 v1.3.0 起，`/etc/init.d/at-webserver` 的 `ensure_modem_interface()` 会幂等地把接口
`auto` 置 1 并在等待 `eth2` 就绪后 `ifup`；后端每次连上模组后也会调用
`ensure_autodial()` 对齐拨号状态（已在目标状态则不重复下发）。两项默认值：

| UCI 键 | 默认 | 含义 |
|:--|:--|:--|
| `network.MT5700M.auto` | `1` | 开机自启接口 |
| `at-webserver.config.autodial_enable` | `1` | 连上模组后确保自动拨号开启 |
| `at-webserver.config.autodial_mode` | `1` | 1=USB 网络接口，2=转网口模式 |

手动触发一次对齐：

```sh
/etc/init.d/at-webserver start      # 走完整 start_service + ensure_modem_interface
logread -e at-webserver | tail -20
```

### 服务状态怎么看

「服务配置」页顶部的状态标签按以下优先级判定，并附带原因提示：

| 状态 | 颜色 | 含义与处理 |
|:--|:--|:--|
| 运行中 | 绿 | procd 实例存活，标签旁附带 PID |
| 已禁用 | 灰 | UCI `enabled=0`，服务被刻意关闭 |
| 未安装 | 红 | 找不到 `/usr/bin/at-webserver-rust`，需重装软件包 |
| 不可执行 | 红 | 二进制缺少执行位，执行 `chmod 0755` |
| 未注册 | 橙 | 已启用且二进制正常，但 procd 无实例——通常是 `/etc/init.d/at-webserver` 缺失或被 overlay 白化 |
| 已停止 | 红 | 实例已注册但进程未运行，查日志后重载 |

排查命令：

```sh
# 服务脚本是否还在？（ROM 里应有，overlay 不得有白化设备）
ls -l /etc/init.d/at-webserver /rom/etc/init.d/at-webserver
ls -l /overlay/upper/etc/init.d/at-webserver   # c--------- 0,0 即为白化，需删除该白化节点

# procd 注册状态与进程
ubus call service list '{"name":"at-webserver"}'
ps w | grep at-webserver-rust | grep -v grep

# 不经 init 脚本，直接用 ubus 拉起（init 脚本缺失时的应急路径，页面「重载服务」按钮即走此路）
ubus call service set '{"name":"at-webserver","instances":{"instance1":{
  "command":["/usr/bin/at-webserver-rust"],"respawn":["3600","5","5"],
  "stdout":true,"stderr":true}}}'

# 日志
logread -e at-webserver | tail -30
```

### AT 终端「命令无响应」

现象：AT 调试终端里 `ATI` 能正常返回，其余命令全部无任何回复（既无结果也无报错）。

根因：后端的命令应答超时（2s）**从进入发送函数就开始计时**，而函数内部要先「等命令通道空闲」→「等 100ms 命令间隔」→「才写入命令等应答」。服务刚启动或模组重连时，`init_modem()` 会连续下发 8 条初始化命令（`AT+CMEE=2`、`AT+CNMI?/=`、`AT+CMGF?/=`、`AT+CLIP=1`、`AT^SETAUTODIAL?/=`）并全程持有通道锁，用户命令的 2 秒预算被排队耗尽，命令根本没写进模组。因此只在该时间窗内的命令会集体静默失败。

`v1.3.1` 起，排队等待改用独立预算（8s），不再挤占应答超时；两类失败也给出不同文案：

| 返回文案 | 含义 | 处理 |
|:--|:--|:--|
| 等待空闲通道超时（8s）：模组正忙或正在重连，请稍后重试 | 命令尚未发出，通道被占用 | 等待数秒后重试 |
| 模组无响应（已等待 2000ms）：`<命令>` | 命令已写入，模组未按时终结 | 检查命令语法与模组状态 |
| 模组未返回内容：`<命令>` | 模组直接回空行 | 确认模组是否已就绪 |

若仍偶发失败，先确认最近是否有服务重启：

```sh
logread -e at-webserver | tail -30
# 观察是否有 init_modem 初始化序列紧随其后
```

### 签约速率显示异常

现象：「网络状态」页「连接状态」面板与「实时速率」面板的下行/上行速率显示为极小的数值
（如 `819 bps`），与实际签约带宽（如 100 Mbps 档）明显不符。

根因：同一组速率状态变量被**两种物理单位不同的数据源**共用，而格式化函数只实现了其中一种口径。

| 数据源 | 来源字段 | 物理单位 | 正确换算 |
|:--|:--|:--|:--|
| PDCP 实时速率 | `d.rx_rate` / `d.tx_rate` | 字节/秒（÷1024 后为 KiB/s） | ×8 得 bps |
| 签约速率 | `AT^DSAMBR` 第 2/3 字段 | kbps（本身即比特单位） | ×1000 得 bps |

`AT^DSAMBR` 按手册 16.17 节定义为 `^DSAMBR: <cid>,<DlApnAmbr>,<UlApnAmbr>`，
`DlApnAmbr` / `UlApnAmbr` 单位均为 **kbps**。实机返回示例：

```
^DSAMBR: 1,102400,102400,"cmiot5g",5
```

即下行签约速率 = 102400 kbps = **102.40 Mbps**。原实现先对 kbps 值做了一次 `/1000`
（把 kbps 误当 bps 降了一档），随后又无条件 `×8`（按字节口径换算），两次错误叠加：

```
102400 kbps  --(/1000)-->  102.4  --(×8)-->  819.2  -->  显示 "819 bps"
```

`v1.3.2` 起，速率状态引入显式单位口径字段 `speedUnit`（`'bytes'` / `'kbps'`），
由赋值方声明单位、格式化函数据此选择换算路径，不再隐式假设；`v1.3.3` 起进一步
按**面板语义**拆成两组彼此独立的变量，杜绝不同来源共用同一组状态：

| 面板（`h3.at-panel-title`） | 状态变量 | 数据来源 | 单位口径 |
|:--|:--|:--|:--|
| 连接状态 | `ambrDown` / `ambrUp` | `AT^DSAMBR` 签约速率 | `kbps`（`×1000`） |
| 实时速率 | `rtDown` / `rtUp` | OpenWrt 接口统计差分 | `bytes`（`×8`） |

其中「实时速率」自 `v1.3.3` 起**不再下发任何 AT 命令**：原先依赖的 PDCP 速率订阅
（`^DSFLOW`/PDCP 上报）会持续占用模组 AT 通道、干扰正常业务，改为直接读取
`/sys/class/net/<dev>/statistics/{rx,tx}_bytes` 做两次采样差分（每秒一次），
设备名由 `uci get network.MT5700M.device` 自动探测（实机为 `eth2`），取不到时回退
`eth2`。该读取经新增的 ubus 方法 `mt5700 netrate` 暴露，前端无需 AT 通道。

修复后「连接状态」显示签约速率 `102.40 Mbps`、「实时速率」显示接口实际吞吐
（实测 `319.35 Kbps` / `238.04 Kbps`，随流量波动），两者互不串扰。
若后续新增速率来源（如 QoS 协商速率），只需在赋值处声明一次单位归属即可。

> 注：`^DSAMBR` 的第 4 字段（如 `"cmiot5g"`）在手册标准格式中并不存在，属部分固件版本的
> 扩展字段。前端已加护栏：仅当该字段确实是**带引号的字符串**时才采信为 APN 显示，
> 若为纯数字则忽略，避免把计数值误显示成 APN。

---

## 功能一览

| 分组 | 页面 |
|:--|:--|
| 网络 | 网络状态 · 网络设置 · 拨号设置 · 全网扫频 · 定时锁频 |
| 模组 | 模组设置 · 模组升级 |
| 短信 | 短信中心 · 短信设置（含 USSD） |
| 工具 | AT 调试终端 · 通知日志 · 服务配置 |

原 WebUI 的深层能力均已保留，例如：

- 服务小区 / 辅载波聚合（`^MONSSC` · `^CASCELLINFO`）
- 网络拒绝原因（`^REJINFO`）实时面板
- SIM 卡状态（`^SIMSQ`）、温度保护、PDCP 实时速率
- 定时锁频（夜间/日间）、全网扫频、企业微信通知

---

## 架构

```text
                    ┌─────────────────────────────────────┐
                    │                LuCI                 │
                    │   12 个页面 · L.rpc.declare('mt5700')│
                    └──────────────────┬──────────────────┘
                                       │  ubus / rpcd 会话 + ACL
                    ┌──────────────────▼──────────────────┐
                    │         rpcd + ucode 插件           │
                    │   mt5700.uc（读 UCI，附 auth_key）   │
                    └──────────────────┬──────────────────┘
                                       │  TCP newline-JSON
                                       │  仅 127.0.0.1:8765
                    ┌──────────────────▼──────────────────┐
                    │        Rust at-webserver-rust       │
                    │  RpcServer · AtClient · Scheduler   │
                    │  URC 分发 · PDU · 扫频 · 通知       │
                    └──────────────────┬──────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
         /dev/ttyUSB1              192.168.8.1:20249            UCI
            (PCUI)                    (TCP 备用)           at-webserver
```

要点：

- **无 WebSocket 对外端口**：后端只监听回环；页面经 rpcd 代理，依赖 LuCI 登录态 + ACL。
- **事件**：后端维护事件总线（`raw_data` / `new_sms` / `incoming_call` / `pdcp_data` / `cellscan` / `memory_full` / `urc_data`），前端约 1.5s 轮询 `events(since)`。
- **命令**：`mt5700.at` 返回 `{success,data,error}`，前端仍串行发送，避免串号。
- **默认 PCUI**：`connection_type=SERIAL`，串口优先 `/dev/ttyUSB1`；`serial_port=auto` 时自动探测。

---

## 项目结构

```text
luci-app-mt5700/                     # 仓库根 = OpenWrt 单包
├── Makefile                         # PKG_NAME=luci-app-mt5700 · PKG_VERSION=1.2.0
├── .github/workflows/build-openwrt.yml
├── scripts/sdk-build.sh             # Actions 容器内：SDK + zig + cargo + 校验
├── htdocs/luci-static/resources/
│   ├── at-webserver/                # rpc.js · parse.js · ui.js · smsEncode.js · at.css
│   └── view/at-webserver/           # 12 个页面
├── po/                              # 中文翻译
├── root/
│   ├── etc/config/at-webserver      # UCI 默认（SERIAL / ttyUSB1）
│   ├── etc/init.d/at-webserver      # procd
│   └── usr/share/rpcd/ucode/mt5700.uc
├── src/
│   ├── Makefile                     # 编译并安装 at-webserver-rust 到本包
│   └── rust/                        # tokio 后端（约 13 个源文件）
└── tests/mock-modem/                # 无硬件 e2e（mock AT 模组）
```

---

## 云编译与发布

workflow：`.github/workflows/build-openwrt.yml`  
镜像：官方 `openwrt/sdk`

| 目标系统 | 包格式 | 架构 | 产物示例 |
|:--|:--|:--|:--|
| 主线 snapshot | `.apk` | x86_64 · aarch64_cortex-a53 | `x86_64-luci-app-mt5700-1.2.0-r1.apk` |
| 23.05.5 | `.ipk` | x86_64 · aarch64_cortex-a53 | `x86_64-luci-app-mt5700_1.2.0_x86_64.ipk` |

**触发方式**

1. push 到 `main`
2. 打 `v*` 标签（如 `v1.2.0`）
3. Actions 手动 `Run workflow`

**每次编译成功后自动发布 Release**

- 标签推送 → Release tag = 标签名  
- `main` 推送 → Release tag = `Makefile` 中的 `PKG_VERSION`（当前 `v1.2.0`）  
- 同名 Release 先删后建；资产带架构前缀，避免同名冲突

交叉编译：容器内 rustup + **zig** 作 musl 链接器；`src/Makefile` 在包编译时 `cargo build --release` 并装入 `usr/bin/at-webserver-rust`。CI 会校验主包体积（>500KB，排除「只有前端」）。

---

## 本地开发与测试

### Rust

```sh
cd src/rust
cargo test              # PDU 单测 7/7
cargo build --release
```

> Windows 上路径若含中文，可能影响 dlltool；建议用纯 ASCII 路径编译。

### 无硬件端到端

```sh
cd tests/mock-modem
npm install ws          # 仅测试依赖
sh run-e2e.sh           # mock 模组 + 真实 Rust + RPC 客户端
node parse-extra-test.js
```

### 页面语法

```sh
# 仓库根
find htdocs -name '*.js' -exec node --check {} \;
```

---

## UCI 配置

配置文件：`/etc/config/at-webserver`，**单 section `config` + 扁平键**（与 Rust / ucode / 服务配置页一致）。

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `enabled` | `1` | 总开关 |
| `connection_type` | `SERIAL` | `SERIAL`=PCUI 串口；`NETWORK`=TCP 备用 |
| `serial_port` | `auto` | `auto` 优先探测 ttyUSB1；可填 `/dev/ttyUSB1` |
| `serial_baudrate` | `115200` | 波特率 |
| `autodial_enable` | `1` | 连上模组后确保自动拨号开启（关掉则接口拿不到 IP） |
| `autodial_mode` | `1` | `1`=USB 网络接口，`2`=转网口模式 |
| `network_host` / `network_port` | `192.168.8.1` / `20249` | 网络通道 |
| `websocket_port` | `8765` | 后端 RPC 端口（仅回环） |
| `websocket_auth_key` | 空 | 由 ucode 自动附带；空则不校验密钥 |
| `notify_*` / `wechat_webhook` | 见默认文件 | 通知 |
| `schedule_*` | 见默认文件 | 定时锁频 |

改配置后：

```sh
uci commit at-webserver
service at-webserver restart
# 或在 LuCI「服务配置」页点「保存并应用」（会自动 reload）
```

---

## Rust 后端

| 模块 | 职责 |
|:--|:--|
| `main.rs` | 装配与优雅退出 |
| `rpcserver.rs` | TCP RPC、伪命令、事件总线、扫频 |
| `atclient.rs` | 命令串行、超时、URC 分流、连上模组后对齐自动拨号 |
| `transport.rs` / `serial_*.rs` | TCP / 串口通道 |
| `pdu.rs` | SMS PDU 编解码 |
| `urc.rs` | 来电/短信/信号等上报 |
| `schedule.rs` / `schedconfig.rs` | 定时锁频 |
| `notify.rs` | 日志与 WebHook |
| `config.rs` | UCI 读取 |

依赖：`tokio` · `serde` · `chrono` · `ureq` · `libc` 等。  
Release：`opt-level=s` + LTO + strip，musl 静态链接，适合嵌入式。

---

## 许可

本项目以 **[MIT License](LICENSE)** 发布，Copyright (c) 2026 LianXia233。

Rust 后端（`src/rust/`）在 `Cargo.toml` 中同样声明 `license = "MIT"`，两层一致。

**MT5700M** 相关 AT 行为以厂商手册为准；本项目在无官方 OpenWrt 包源的前提下提供管理界面与后端。
