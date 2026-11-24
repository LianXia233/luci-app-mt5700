<div align="center">

<img src="docs/images/mascot.png" alt="MT5700M 5G Mascot" width="108" height="108" style="border-radius: 50%; box-shadow: 0 4px 16px rgba(0,0,0,0.12); margin-bottom: 8px;" />

# AT WebServer · MT5700M 5G 模组管理 (Debian 独立版)

**专为 Debian / Ubuntu Linux 打造的 MT5700M 5G 模组独立管理套件与系统级守护服务**

[![Version](https://img.shields.io/badge/Version-debian--v1.32.13-3b82f6?style=flat-square&logo=git&logoColor=white)](CHANGELOG.md)
[![Debian CI](https://img.shields.io/github/actions/workflow/status/LianXia233/luci-app-mt5700/build-deb.yml?branch=Debian&label=Debian%20Build%20(deb)&style=flat-square&logo=debian&logoColor=white)](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/build-deb.yml)
[![Static Checks](https://img.shields.io/github/actions/workflow/status/LianXia233/luci-app-mt5700/checks.yml?branch=Debian&label=Checks&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/checks.yml)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square&logo=gnu&logoColor=white)](LICENSE)

[![Debian](https://img.shields.io/badge/Debian-13+%20(Trixie)-D70A53?style=flat-square&logo=debian&logoColor=white)](https://www.debian.org/)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04+%20LTS-E95420?style=flat-square&logo=ubuntu&logoColor=white)](https://ubuntu.com/)
[![Backend](https://img.shields.io/badge/Backend-Rust%20%7C%20Tokio-DEA584?style=flat-square&logo=rust&logoColor=white)](src/rust/)
[![Arch](https://img.shields.io/badge/Arch-amd64%20%7C%20arm64-8b5cf6?style=flat-square&logo=linux&logoColor=white)](https://github.com/LianXia233/luci-app-mt5700/releases)

[![Release](https://img.shields.io/github/v/release/LianXia233/luci-app-mt5700?filter=debian-v*&label=Release&style=flat-square&color=success&logo=github)](https://github.com/LianXia233/luci-app-mt5700/releases)
[![WebUI](https://img.shields.io/badge/WebUI-Port%209000-0ea5e9?style=flat-square&logo=googlechrome&logoColor=white)](#-开箱即用)
[![GitHub Stars](https://img.shields.io/github/stars/LianXia233/luci-app-mt5700?style=flat-square&logo=github)](https://github.com/LianXia233/luci-app-mt5700/stargazers)
[![Main Branch](https://img.shields.io/badge/Main%20Branch-OpenWrt%20%2F%20LuCI-181717?style=flat-square&logo=git)](https://github.com/LianXia233/luci-app-mt5700/tree/main)
[![CNB Mirror](https://img.shields.io/badge/镜像仓库-CNB-2F54EB?style=flat-square)](https://cnb.cool/LianXia233/luci-app-mt5700)

<p align="center">
  <b>🐧 脱离 OpenWrt 专有组件</b>：将 12 个现代化管理视图与高性能常驻后端完整迁移至通用 Linux<br>
  无缝替代 LuCI / ubus / UCI · 纯 Rust 异步并发后端 · systemd 原生守护 · 串口独占优先级调度 · 官方 amd64/arm64 deb 云编译
</p>

<p align="center">
  <a href="#-快速安装部署">🚀 快速安装</a> •
  <a href="#-核心功能">✨ 核心功能</a> •
  <a href="#-系统架构">🏛️ 系统架构</a> •
  <a href="#-配置指南">⚙️ 配置指南</a> •
  <a href="#-http--websocket-api">📡 API 参考</a> •
  <a href="#-与-mainopenwrt分支的差异">🔀 分支对比</a> •
  <a href="#-许可证与开源声明">📄 开源协议</a>
</p>

</div>

---

> [!NOTE]
> **📌 分支定位与基线说明**
> - **Debian 分支专为标准 Linux 发行版打造**：移除对 `LuCI`、`ubus`、`rpcd`、`UCI`、`netifd` 等 OpenWrt 专有组件的全部依赖，以 **独立 WebUI + HTTP API / WebSocket + JSON 配置 + systemd 服务** 原生融入 Debian / Ubuntu 生态。
> - **基线全量同步**：当前分支基线与 `main` 主线 **v1.32.13（2026-11-24）** 逐字节同步，核心 UI 与 AT 处理逻辑完全一致。原 OpenWrt 版继续保留于 [`main`](https://github.com/LianXia233/luci-app-mt5700/tree/main) 分支。

> [!WARNING]
> **⚠️ 二进制运行库依赖提示**
> GitHub Actions 官方提供的预编译 deb 产物在 **Ubuntu 24.04** 原生环境中构建，二进制最低依赖 **GLIBC 2.39+**。
> - **完美支持**：Debian 13 (Trixie)+、Ubuntu 24.04 LTS+ 及更新版本；
> - **旧版本系统**（如 Debian 12 Bookworm / GLIBC 2.36）：请在目标机器上通过 [源码一键安装](#方式二源码一键安装自行编译) 脚本本地编译，即可正常运行。

---

## ✨ 核心功能

全量复刻主线 12 大核心功能模块，满足从日常监控到高级调优的全场景需求：

| 模块分类 | 功能特性亮点 |
| :--- | :--- |
| 📊 **网络全维监控** | 设备基础信息展示、射频打分看板、四维信号参数（RSRP / RSRQ / SINR / RSSI）、模组 6 档温度监测 |
| 📡 **SIM 与蜂窝射频** | SIM 状态与 ICCID、IMEI 管理、运营商识别、5G NR / LTE 多频段显示、CA 载波聚合状态解析 |
| 🌐 **自动拨号与对账** | NDIS 自动拨号状态机、APN 智能推断、`on-uplink.sh` DHCP 网口拉起钩子、PDCP 业务与网卡流量多源对账 |
| 🔍 **全网扫频与锁频** | 异步全网盲扫任务（支持进度实时回显与随时中断取消）、日夜双策略定时频段倒换编排 |
| 💬 **短信中心与交互** | 现代化对话式短信收发/批量删除/导出、SMSC 短信中心设置、USSD 交互指令 |
| 🔔 **多通道智能告警** | 短信/来电/信号异常事件捕获，支持 **企业微信 WebHook** 与 **QQ 机器人（官方 API v2）** 实时推送 |
| 🛠️ **模组维护与终端** | 在线 FOTA 固件升级、Web 交互式 AT 调试终端、实时运行日志滚屏、journalctl 系统日志一键回溯 |

---

## 🏛️ 系统架构

Debian 分支采用高内聚、低耦合的松散分层架构设计，实现了浏览器与硬件串口的高效隔离与异步并发：

```
浏览器 (客户端) ──────── HTTP (:9000) ────────> at-webserver (Rust + Tokio)
      │                                                ├── httpserver.rs    HTTP RESTful API + WebSocket + 静态 WebUI
      │                                                ├── rpcserver.rs     TCP newline-JSON RPC (保留，用于 e2e/内部调试)
      │                                                ├── atclient.rs      AT 客户端 (串口/TCP 独占管道 + 双级优先级队列)
      │                                                ├── schedule.rs      定时锁频调度编排
      │                                                ├── urc.rs           主动上报分发总线 (短信/来电/URC 事件分发)
      │                                                └── state.rs         状态高速缓存 (后台轮询预热，毫秒级响应)
      └─── WebSocket (:9000/ws) ───────────────────────┘
           (全双工实时事件推送: 短信/来电/扫频进度/URC)
```

### 核心技术优势

1. **前后端极致解耦**：前端 WebUI（`webui/`）为纯静态资源，由后端 `httpserver.rs` 高性能托管；所有业务数据流均走 RESTful HTTP API 与 WebSocket 推送。
2. **AT 通道独占与分级队列**：硬件串口天然单通道串行，后端构建统一请求队列：
   - **High 优先级**：用户手动操作（网页提交、短信发送、AT 交互终端）；
   - **Low 优先级**：后台遥测刷新、信号参数轮询；
   - 彻底避免并发命令踩踏与界面阻塞。
3. **双轨实时同步机制**：
   - 实时推送：全双工 WebSocket（`/ws`）毫秒级投递上报；
   - 增量保底：单调递增序号（`seq`）事件总线，前端支持 `/api/events?since=N` 自动断线重连与对齐，告警与状态永不丢帧。
4. **轻量级 LuCI 兼容垫片**：通过 `webui/luci.js` 模拟 LuCI 的 `L.rpc`、`L.uci`、`L.fs` 等核心 API，原主线 12 个视图文件无需重构即可原样复用，兼顾开发效率与一致性体验。
5. **无打包源码直出**：前端资源不经 Webpack/Vite 压缩混淆，浏览器接收的即为易读源码，极大地简化了现场排查与调试工作。

---

## 📁 目录结构

```
├── webui/                         # 独立 WebUI 静态资源 (后端直出托管)
│   ├── index.html                 # 单页面应用入口
│   ├── app.js                     # 纯前端路由调度与动态模块加载器
│   ├── luci.js                    # LuCI 兼容垫片 (桥接 L.rpc / L.uci / L.fs / E)
│   ├── shell.css                  # Debian 独立外壳框架样式
│   ├── _layout-test/              # 离线布局回归测试与静态栅格预览
│   └── luci-static/               # 与 main 分支 htdocs 保持同源逐字节同步
├── src/rust/src/                  # 后端核心源码 (Rust + Tokio)
│   ├── httpserver.rs              # [新增] HTTP REST API + WebSocket 服务
│   ├── configstore.rs             # [新增] JSON 配置存储引擎 (完全替代 UCI)
│   ├── config.rs                  # 扁平化配置解析 (沿用 UCI 语义键名)
│   ├── rpcserver.rs               # TCP RPC 兼容服务与核心业务管道
│   └── ...                        # AT 队列 / 调度器 / URC 事件总线
├── debian/                        # Debian 打包与系统集成套件
│   ├── at-webserver.service       # systemd 服务单元配置文件
│   ├── config.json                # 默认落盘配置 (/etc/mt5700/config.json)
│   ├── on-uplink.sh               # 模组网口拉起与 DHCP 拨号就绪钩子
│   ├── install.sh                 # 源码一键编译与部署脚本
│   ├── build-deb.sh               # 本地/CI 通用 deb 智能打包脚本
│   ├── sync-webui.sh              # WebUI 资源同源同步维护脚本
│   └── ci-verify.sh               # 本地全流程 CI 闸门复现脚本
├── .github/workflows/
│   └── build-deb.yml              # 官方原生 amd64 + arm64 双架构自动化云编译
├── tests/                         # 全覆盖单元测试与端到端测试套件
│   ├── mock-modem/                # 虚拟模组仿真与 AT 协议 mock e2e 测试
│   └── debian-webui-test.js       # WebUI 同步字节漂移校验门禁
```

---

## 🚀 快速安装部署

支持 **Debian 13+** 与 **Ubuntu 24.04+**。根据您的使用环境选择最方便的安装途径：

### 方式一：安装预编译 deb 包（推荐）

从 [GitHub Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载最新发布的 `debian-v*` 架构软件包：

```bash
# 适用于树莓派 4/5、ARM 工业网关 (aarch64 / arm64)
sudo apt install ./at-webserver_1.32.13-1_arm64.deb

# 适用于 PC、x86 软路由、云服务器、虚拟机 (x86_64 / amd64)
sudo apt install ./at-webserver_1.32.13-1_amd64.deb
```

> [!TIP]
> **智能包管理与热部署优势**：
> - `apt` 会自动完成系统依赖校验、二进制复制并注册 systemd 服务（自动执行 `daemon-reload` + `enable` + `start`）。
> - **容错机制**：即使安装时尚未插入 5G 模组，安装流程也不会中断报错；插入模组后只需执行 `sudo systemctl restart at-webserver`。
> - 配置文件 `/etc/mt5700/config.json` 注册为标准 **conffile**，后续版本升级时会自动保留您自定义的所有配置。
> - 卸载与清理：常规卸载保留配置 `sudo apt remove at-webserver`；彻底清理配置文件执行 `sudo apt purge at-webserver`。

---

### 方式二：源码一键安装（自行编译）

针对旧版系统（如 Debian 12 / Ubuntu 22.04）或需要自定义特性的场景，直接一键编译部署：

```bash
# 1. 安装编译基础工具链
sudo apt install -y build-essential pkg-config curl

# 2. 执行全自动编译安装脚本
sudo ./debian/install.sh
```

脚本将自动完成：检测/拉取 Rust 环境 → 编译 `src/rust` 二进制产物 → 安装 WebUI 静态资源 → 初始化 `/etc/mt5700/` 配置与钩子 → 写入并启动 systemd 系统服务。

> [!NOTE]
> `install.sh` 支持实用参数：
> - `sudo ./debian/install.sh --bin /path/to/binary`：复用已编译好的二进制，仅执行资源部署；
> - `sudo ./debian/install.sh --no-deps`：跳过包管理器依赖检测。

---

### 方式三：手动分步部署

```bash
# 1. 编译后端
cd src/rust && cargo build --release

# 2. 安装可执行文件
sudo install -m 0755 target/release/at-webserver /usr/bin/at-webserver

# 3. 部署 WebUI 静态资源
sudo mkdir -p /usr/share/mt5700 && sudo cp -r ../../webui /usr/share/mt5700/webui

# 4. 部署默认配置文件与 systemd 单元
sudo mkdir -p /etc/mt5700
sudo cp ../../debian/config.json /etc/mt5700/config.json
sudo cp ../../debian/at-webserver.service /etc/systemd/system/

# 5. 重载并启动服务
sudo systemctl daemon-reload
sudo systemctl enable --now at-webserver
```

---

### 方式四：本地自主打包 .deb

无需连接 GitHub Actions，在本地开发机即可打包出生产级别的 deb 安装包：

```bash
# 编译并打包当前机器架构 (x86_64 机器即生成 amd64.deb)
debian/build-deb.sh

# 传入已有二进制跳过编译 (架构自 ELF 头部动态识别)
debian/build-deb.sh --bin src/rust/target/release/at-webserver

# 自定义修订版本号 (默认打包为 <version>-1)
debian/build-deb.sh --revision 2
```

> [!IMPORTANT]
> **deb 打包脚本的三大严谨设计**：
> 1. **版本唯一真理源**：严格提取 `src/rust/Cargo.toml` 中的 `version` 字段，杜绝包版本与后端二进制版本不符的低级错误。
> 2. **自 ELF 机器码严密判定**：直接从二进制文件的 ELF Header 读取目标架构，而非盲信宿主机的 `dpkg --print-architecture`。在交叉编译时可防止产出“amd64 外壳却装有 arm64 二进制”的损坏包。
> 3. **依赖关系动态推导**：基于 `objdump -p` 提取的 `NEEDED` 动态库条目，精准映射至系统 Debian 包依赖，避免硬编码带来的冗余或遗漏。

---

## 🌐 开箱即用

服务成功启动后，使用现代浏览器访问管理控制台：

```text
http://<设备IP>:9000
```

- **默认侦听端口**：`0.0.0.0:9000`
- **串口探测模式**：默认 `auto`（智能识别 PCUI 串口，优先探测 `/dev/ttyUSB1`）
- **默认波特率**：`115200`
- **访问认证**：默认空（无须鉴权，可在配置中启用 `auth_key`）

---

## ⚙️ 配置指南

配置文件位于：`/etc/mt5700/config.json`（扁平 JSON 格式，键名完全沿用原 UCI 语义）。

```json
{
  "connection_type": "SERIAL",
  "serial_port": "auto",
  "serial_baudrate": 115200,
  "http_port": 9000,
  "http_bind": "0.0.0.0",
  "auth_key": "",
  "web_root": "/usr/share/mt5700/webui",
  "netdev": "",
  "log_file": "/tmp/at-notifications.log",
  "schedule_enabled": "0"
}
```

### 两种配置生效方式

1. **热应用（无需重启）**：
   在 WebUI「服务配置 → 保存并应用」或调用 `POST /api/config/apply`。
   *适用于*：定时锁频规则（`schedule_*`）、推送通知开关等。
2. **冷重启（生效重启）**：
   修改了底层结构性配置（如连接协议、串口路径、波特率、HTTP 绑定端口、认证密钥等）。
   WebUI 会智能提示重启需求；后端进程退出后将由 systemd 自动拉起重载。

### 核心参数详解

| 配置键名 | 类型 | 说明 | 默认值 | 生效方式 |
| :--- | :--- | :--- | :--- | :--- |
| `connection_type` | String | 模组连接介质：`SERIAL`（本地串口）/ `NETWORK`（远程 TCP） | `SERIAL` | 重启 |
| `serial_port` | String | 模组 PCUI 串口路径，填 `auto` 启用全自动智能探测 | `auto` | 重启 |
| `serial_baudrate` | Number | 串口通信波特率 | `115200` | 重启 |
| `http_port` | Number | WebUI 与 REST API 侦听端口 | `9000` | 重启 |
| `http_bind` | String | HTTP 服务绑定的网络地址 | `0.0.0.0` | 重启 |
| `auth_key` | String | 访问认证密钥（启用后所有 HTTP / WebSocket 均须鉴权） | `""` (不启用) | 重启 |
| `web_root` | String | WebUI 静态文件所在物理路径 | `/usr/share/mt5700/webui` | 重启 |
| `netdev` | String | 流量统计网络接口（留空则自动识别模组 USB 网卡） | `""` (自动) | 热应用 |
| `log_file` | String | 通知事件运行日志输出路径 | `/tmp/at-notifications.log` | 热应用 |
| `schedule_enabled`| String | 定时锁频总开关（`"1"` 启用 / `"0"` 停用） | `"0"` | 热应用 |

- **环境变量重载**：可通过 `MT5700_CONFIG` 指定自定义配置文件路径，`MT5700_WEBROOT` 指定自定义 WebUI 路径。
- **网口拉起钩子**：模组拨号建立后的系统回调路径固定为 `/etc/mt5700/on-uplink.sh`（由 deb 包或安装脚本默认配置）。

---

## 📡 HTTP & WebSocket API

Debian 分支提供了标准的 RESTful 与全双工通信接口，支持自动化脚本或第三方平台集成：

### 1. 核心业务接口

| 方法 | 路由端点 | 描述说明 | 认证需求 |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/at` | 交互式执行 AT 命令（Payload: `{"cmd": "AT+CSQ"}`） | 是* |
| `GET` | `/api/events?since=N` | 增量拉取系统/通知事件（长轮询断线补偿） | 是* |
| `GET` | `/api/logs?since=&limit=` | 查看后端最近服务运行时日志 | 是* |
| `GET` | `/api/netrate?device=` | 读取 sysfs 接口累积收发字节（零 AT 串口开销） | 是* |
| `GET` | `/api/usb` | 查询模组当前 USB 物理链路速率（如 5Gbps USB 3.0） | 是* |
| `GET` | `/api/syslog?lines=` | 回溯获取 journalctl 记录的系统级运行日志 | 是* |
| `GET` | `/api/file/read\|list\|stat`| 受限白名单文件读取、设备清单枚举与二进制自检 | 是* |
| `POST` | `/api/file/write` | 受限安全写入（用于通知日志更新等） | 是* |

### 2. 模组与业务 RPC 兼容接口

| 方法 | 路由端点 | 描述说明 |
| :--- | :--- | :--- |
| `POST` | `/api/rpc/mt5700/sms` | 短信核心事务（短信列表、即时发送、单条/批量删除、容量统计、SMSC 地址设置） |
| `POST` | `/api/rpc/mt5700/usage` | 流量统计快照、月度基准清零、网卡源切换与周期持久化 |
| `POST` | `/api/rpc/mt5700/batch` | 批量并行/串行执行多条 AT 状态查询 |
| `POST` | `/api/rpc/mt5700/notify_test` | 企业微信 WebHook / QQ 机器人推送通道快速连通性测试 |
| `POST` | `/api/rpc/mt5700/qq_bind_status` | 查询 QQ 官方开放平台机器人的账号绑定状态与菜单配置 |
| `POST` | `/api/rpc/mt5700/task_status` | 查询/列出/取消正在后台执行的长时间异步任务（如全网扫频） |
| `POST` | `/api/rpc/service/list\|set` | 服务管理与兼容接口映射 |

### 3. 配置管理与全双工推送

| 方法 | 路由端点 | 描述说明 |
| :--- | :--- | :--- |
| `GET` | `/api/config` | 获取当前全部生效的 JSON 配置项 |
| `POST` | `/api/config` | 批量保存合并配置并安全落盘 |
| `POST` | `/api/config/apply` | 执行热应用，返回 `{"success": true, "restart_required": bool}` |
| `GET` | `/api/service/status` | 获取服务运行健康状态、连接时长及可用串口列表 |
| `POST` | `/api/service/restart` | 发送软重启指令（由 systemd 自动拉起） |
| `GET` | `/ws` | **WebSocket 全双工端点**：实时监听短信息、来电呼入、扫频实时进度与模组 URC |

> [!NOTE]
> **API 鉴权规范**：当在配置中设置了 `auth_key` 时：
> - HTTP 请求头须携带：`X-Auth-Key: <your_key>`；
> - WebSocket 连接须在 Query 中携带：`ws://<ip>:9000/ws?key=<your_key>`。

---

## 🔀 与 main（OpenWrt）分支的差异

本分支专为通用 Debian/Ubuntu 设计，两者的体系架构差异对比如下：

| 维度对比 | OpenWrt 主线 (`main`) | Debian 独立版 (`Debian`) |
| :--- | :--- | :--- |
| **操作系统** | OpenWrt 24.10 / 25.x、ImmortalWrt | Debian 13+ (Trixie)、Ubuntu 24.04 LTS+ |
| **服务守护** | procd (`/etc/init.d/at-webserver`) | systemd (`at-webserver.service`) |
| **前端呈现** | 原生 LuCI 页面框架（由 `uhttpd` 服务） | 独立轻量 WebUI（Rust 后端自托管在端口 9000） |
| **前后端通道** | `ubus` → `ucode` 转换中间件 → TCP RPC | 标准 HTTP RESTful API + 全双工 WebSocket |
| **配置存储** | UCI 扁平文件（`/etc/config/at-webserver`） | 现代 JSON 配置（`/etc/mt5700/config.json`） |
| **网口状态机**| netifd / hotplug / ifup 协同 | `on-uplink.sh` DHCP 自动挂载钩子 |
| **系统日志** | syslogd / `logread` | systemd `journalctl` |
| **软件打包** | `.ipk` / `.apk`（OpenWrt SDK 交叉编译） | `.deb` 标准包（支持 apt 安装管理与版本升级） |
| **编译机制** | 依赖对应架构的 OpenWrt SDK | 原生 `cargo build` 或一键 `build-deb.sh` |
| **前端资源** | 可在构建期执行压缩（`LUCI_MINIFY_JS`） | **保持源码直出不压缩**，极其利于排查与二开 |
| **CI 云编译** | GitHub Actions 矩阵构建 ipk/apk | GitHub 官方原生 x86_64 与 arm64 双 runner 构建 deb |
| **发布标签** | `v*`（如 `v1.32.13`） | 空间完全隔离的 `debian-v*`（如 `debian-v1.32.13`） |

---

## 🔄 前端同源同步机制

`webui/luci-static/resources/**` 与主线 `main` 分支的 `htdocs/luci-static/resources/**` 保持**逐字节同源同步**。这意味着主线的所有 UI 增强与 Bugfix，均可直接合并生效，无需经历复杂编译：

| 资源类别 | 对应路径文件 | 同步与处理策略 |
| :--- | :--- | :--- |
| **主线同源继承** | `htdocs/luci-static/resources/**` 全部资源 | 由 `debian/sync-webui.sh` 脚本全量拉取，`tests/debian-webui-test.js` 逐字节校验 |
| **Debian 特有外壳** | `webui/luci.js`<br>`webui/app.js`<br>`webui/shell.css`<br>`webui/index.html` | **严禁被覆盖**！包含 LuCI 垫片、hash 路由加载器与独立版布局外壳 |
| **后端实现** | `src/rust/` | 同步主线 AT 状态机、通知系统、扫频等核心，附加专属 `httpserver.rs` 与 `configstore.rs` |
| **Debian 套件** | `debian/**` | 独立维护 systemd 单元、deb 打包、on-uplink 脚本与 CI 校验 |

---

## 🧪 自动化测试与 CI 门禁

本项目建立了极其严格的工程级质量保障体系：

```bash
# 1. 后端工程质量检查
cd src/rust
cargo test --locked                         # 执行 Rust 单元测试
cargo clippy --all-targets -- -D warnings   # 严格静态代码检查

# 2. 前端与资源完整性回归测试
cd ../..
node tests/static-check.js                  # 静态依赖分析
node tests/debian-webui-test.js             # WebUI 资源漂移防范检查
for f in tests/*-test.js; do node "$f" || exit 1; done
```

### GitHub Actions 官方原生云编译

当分支推送到 `Debian` 或创建 `debian-v*` 标签时，自动触发 `.github/workflows/build-deb.yml`：

```
GitHub Actions: Debian 软件包云编译（deb）
  ├── 严格门禁      static-check / Node 视图单测 / cargo test / clippy
  ├── 供应链许可证  cargo-about 自动化生成 RUST-DEPENDENCIES.md
  ├── amd64 编译    基于 ubuntu-24.04 (官方 x64 runner) 原生构建
  ├── arm64 编译    基于 ubuntu-24.04-arm (官方 ARM Cobalt 100 runner) 原生构建
  └── 统一发布      校验 SHA256SUMS，自动创建 GitHub Release
```

> [!NOTE]
> **真实 ARM 架构原生编译**：ARM 产物采用 GitHub 官方 ARM64 裸机运行环境（4 vCPU），彻底规避传统 QEMU 模拟与交叉编译环境下的链接库版本差异与潜在 bug。

---

## 🖼️ 界面展示与实测体验

### 1. 离线布局回归预览样张

无需连接实体 5G 模组，即可直接脱离后端静态预览卡片自适应栅格：

```text
http://<host>:9000/_layout-test/status-mock.html
```

### 2. 沙箱环境全功能实测

在 Debian amd64 沙箱中，通过 `socat` 虚拟串口对与 Fibocom AT 模拟器替代真实硬件，完整跑通了初始化、拨号对齐、信号解析到 12 个视图渲染的全过程（**Console Error 严格为 0**）：

<div align="center">

![v2.2.0 沙箱实测总览](docs/screenshots/v2.2.0/_overview.png)

<p align="center"><i>RSRP -63 dBm · SINR 27.2 dB · 256QAM / 64QAM 载波聚合 · 12 大管理视图真实渲染通过</i></p>

</div>

完整实测报告、抓包与各页面高分辨率截图见文档：[`docs/screenshots/v2.2.0/README.md`](docs/screenshots/v2.2.0/README.md)。

---

## 📄 许可证与开源声明

本项目核心代码遵循 **GNU General Public License v3.0 only**（SPDX: `GPL-3.0-only`）协议开源，完整协议条款见 [`LICENSE`](LICENSE)。Debian 安装包会自动将 GPL 授权文本部署至 `/usr/share/doc/at-webserver/copyright`。

### 角色美术素材与知识产权说明

WebUI 界面保留了以下角色的二次创作装饰素材，**均不属于 GPL-3.0-only 授权范围**：
- **头像图标** `mascot.png`：《异环》（NTE）「薄荷」，著作权归苏州幻塔网络科技有限公司（Hotta Studio）/ 完美世界游戏所有。
- **全屏背景** `bg/character-*.webp`：《蔚蓝档案》（Blue Archive）「阿罗娜 / 彩奈」与「普拉娜」，权利归属 `© NEXON Games Co., Ltd. & Yostar, Inc.`。
- **免责与合规声明**：上述素材仅用于个人开源项目的界面美化，不代表权利人任何形式的商业授权。若权利人提出合规要求，维护者将即时移除或替换。素材指纹与处置方案详见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

### 第三方组件依赖许可

- 后端 Rust 依赖均保留各自的上游许可证，并在打包时自动生成依赖清单部署至 `/usr/share/doc/at-webserver/RUST-DEPENDENCIES.md`；
- 内嵌的 Mozilla CA 根证书数据遵循 `CDLA-Permissive-2.0` 协议。

---

<div align="center">

**[luci-app-mt5700](https://github.com/LianXia233/luci-app-mt5700)** · 由 [LianXia233](https://github.com/LianXia233) 维护

如果有任何问题或优化建议，欢迎提交 [Issue](https://github.com/LianXia233/luci-app-mt5700/issues) 或 [Pull Request](https://github.com/LianXia233/luci-app-mt5700/pulls)！

</div>
