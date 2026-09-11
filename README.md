# AT WebServer · MT5700M 5G 模组管理

> **OpenWrt LuCI 插件** · 前端 12 页 + Rust 后端 **单包交付**  
> 包名 `luci-app-mt5700` · 服务/UCI 段 `at-webserver` · 当前版本 **v1.2.0**

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
- [更多文档](#更多文档)

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

浏览器登录 LuCI → **modem → 5G模组管理**（路径 `admin/modem/5g`），即可看到 12 个页面。

> **为何必须有后端进程？** 串口/`AT` 通道、定时锁频、扫频、企业微信推送都必须常驻，浏览器无法完成。  
> 「一个安装包」= 前后端合一（v1.1.0+）；不是「一个静态 HTML」。

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

完整映射见 [`docs/01-原WebUI功能清单与LuCI映射表.md`](docs/01-原WebUI功能清单与LuCI映射表.md)。

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
├── docs/                            # 功能映射 / SDK 说明 / 验收
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
| `network_host` / `network_port` | `192.168.8.1` / `20249` | 网络通道 |
| `websocket_port` | `8765` | 后端 RPC 端口（仅回环） |
| `websocket_auth_key` | 空 | 由 ucode 自动附带；空则不校验密钥 |
| `notify_*` / `wechat_webhook` | 见默认文件 | 通知 |
| `schedule_*` | 见默认文件 | 定时锁频 |

改配置后：

```sh
uci commit at-webserver
service at-webserver restart
# 或在 LuCI「服务配置」页保存（会自动 reload）
```

---

## Rust 后端

| 模块 | 职责 |
|:--|:--|
| `main.rs` | 装配与优雅退出 |
| `rpcserver.rs` | TCP RPC、伪命令、事件总线、扫频 |
| `atclient.rs` | 命令串行、超时、URC 分流 |
| `transport.rs` / `serial_*.rs` | TCP / 串口通道 |
| `pdu.rs` | SMS PDU 编解码 |
| `urc.rs` | 来电/短信/信号等上报 |
| `schedule.rs` / `schedconfig.rs` | 定时锁频 |
| `notify.rs` | 日志与 WebHook |
| `config.rs` | UCI 读取 |

依赖：`tokio` · `serde` · `chrono` · `ureq` · `libc` 等。  
Release：`opt-level=s` + LTO + strip，musl 静态链接，适合嵌入式。

---

## 更多文档

| 文档 | 内容 |
|:--|:--|
| [`docs/01-原WebUI功能清单与LuCI映射表.md`](docs/01-原WebUI功能清单与LuCI映射表.md) | 功能 1–75 与后端 B1–B16 映射 |
| [`docs/02-OpenWrt-SDK交叉编译与安装.md`](docs/02-OpenWrt-SDK交叉编译与安装.md) | SDK、安装/卸载、交叉编译 |
| [`docs/03-最终验收报告.md`](docs/03-最终验收报告.md) | 验收与未执行项说明 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更 |

---

## 许可

以仓库内声明为准（当前 `Cargo.toml` 为 MIT）。

**MT5700M** 相关 AT 行为以厂商手册为准；本项目在无官方 OpenWrt 包源的前提下提供管理界面与后端。
