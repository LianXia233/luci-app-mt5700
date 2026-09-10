# AT WebServer（MT5700M 5G 模组）— LuCI + Rust 重构交付说明

> **OpenWrt 仓库名：`luci-app-mt5700`**（已定稿，单仓库）
> - 与现有包 `luci-app-mt5700m` 不重名、非抄袭（名称、功能定位、代码均为本项目独立实现）；
> - 遵循 OpenWrt `luci-app-<型号>` 命名惯例，与包内 `Makefile` 的 `PKG_NAME`/`LUCI_DEPENDS` 一致；
> - 本仓库根即 LuCI 插件包（可被 `feeds` 直接引用），Rust 后端位于 `src/rust/`；
> - 服务名与 UCI 段名沿用 `at-webserver`（OpenWrt 惯例：包名与内部服务名可解耦，避免破坏既有配置兼容）。

---

## 1. 项目构成

```
luci-app-mt5700/                        # 仓库根 = LuCI 插件包
├── Makefile                            # luci.mk 打包（PKG_NAME=luci-app-mt5700）
├── README.md
├── CHANGELOG.md                        # 更新日志
├── .github/workflows/build-openwrt.yml # GitHub Actions 云编译（主线 apk + 老版 ipk）
├── scripts/sdk-build.sh                # SDK 容器内构建脚本（Actions 调用）
├── docs/
│   ├── 01-原WebUI功能清单与LuCI映射表.md   # 原功能 → LuCI 页面/API 完整映射（8 页 75 项功能 + 后端 B1-B16）
│   ├── 02-OpenWrt-SDK交叉编译与安装.md      # SDK 构建、IPK/APK 打包、安装/卸载、交叉编译
│   └── 03-最终验收报告.md                   # 验收结果与未执行项说明
├── htdocs/luci-static/resources/
│   ├── at-webserver/                   # 公共库：ws.js / parse.js / ui.js / smsEncode.js / at.css
│   └── view/at-webserver/              # 12 个页面 JS
├── po/                                 # 翻译（templates + zh_Hans）
├── root/
│   ├── etc/config/at-webserver         # UCI 默认配置
│   ├── etc/init.d/at-webserver         # procd 服务脚本
│   ├── etc/uci-defaults/at-webserver   # 首次安装初始化
│   ├── usr/share/luci/menu.d/          # 顶部菜单（网络 / 服务 两个顶级入口）
│   └── usr/share/rpcd/acl.d/           # 权限控制
├── src/rust/                           # Rust 后端（独立包 at-webserver-rust）
│   ├── Makefile                        # OpenWrt 包 Makefile（cargo + zig 交叉编译）
│   ├── Cargo.toml
│   └── src/                            # 13 个源文件（见 §4）
└── tests/mock-modem/                   # 本地链路验证（无硬件环境）
    ├── mock-modem.js                   # MT5700 AT 模组模拟器（TCP 20249）
    ├── mock-uci                        # 假 uci（测试配置注入）
    ├── e2e-test.js                     # WS 端到端测试（22 项）
    ├── parse-extra-test.js             # 前端解析层单测（19 项，carrier/reject/simsq）
    └── run-e2e.sh                      # 一键编排
```

## 2. 架构

```
                 OpenWrt
                    │
             ┌──────┴──────┐
             │    LuCI     │  JS + LuCI View/Form/RPC（12 个页面）
             └──────┬──────┘
                    │
               LuCI RPC / WS(8765)
                    │
             ┌──────▼──────┐
             │ Rust Backend│  tokio：WSServer + AtClient + Dispatcher + Scheduler
             └──────┬──────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
      Config      Tasks       System
        │           │           │
       UCI        Process     Modem AT
        │           │           │
        └───────────┴───────────┘
```

- 前端 LuCI 通过 WebSocket 直连 Rust 后端（端口 8765，UCI 可配），**不是** LuCI RPC 转发；
  页面同时用 LuCI UCI API（服务配置页）与 ubus（service reload/restart、日志文件）。
- 与 Go 原版（at-webserver）的 WS 协议完全一致：认证、心跳、`{success,data,error}` 应答、
  FIFO 顺序匹配、raw_data/new_sms/incoming_call/pdcp_data/cellscan/memory_full/urc_data 推送。

## 3. 功能等价性

- 原 WebUI 8 个页面全部迁移，见 `docs/01-原WebUI功能清单与LuCI映射表.md`（功能 1-75、后端 B1-B16）。
- 菜单：原侧边栏 8 项映射为 LuCI **网络 → 5G 模组**（网络状态/网络设置/拨号设置/全网扫频/定时锁频）
  与 **服务 → 5G 模组**（模组设置/模组升级/短信中心/短信设置/AT调试终端/通知日志/服务配置），无入口丢失。
- 全部按钮 → JS → WS → Rust → 模组 → 应答 → UI 更新链路真实（见 §6 测试结果）。
- **未实现项已清零**：原 WebUI 全部功能（含载波辅助小区聚合 `^MONSSC`/`^CASCELLINFO`、`^REJINFO` 网络拒绝原因面板、
  `^SIMSQ` 卡状态、连接诊断面板、温度保护阈值等深层功能）均已完整移植，见 `docs/03-最终验收报告.md`。
- 如实说明：OpenWrt SDK 交叉编译 / IPK·APK 实编译 / 真机安装 / 重启后功能，需在带 SDK 的环境（推荐
  **GitHub Actions 云编译**，见 §8）或真机上执行。

## 4. Rust 后端（src/rust，独立包名 at-webserver-rust，服务名 at-webserver）

| 文件 | 职责 |
|---|---|
| main.rs | 装配、SIGTERM/SIGINT 优雅退出、watch 统一关闭 |
| logger.rs | 分级日志（stdout 由 procd/logd 接管） |
| config.rs | UCI 读取（`uci show at-webserver`）、默认值、键解析 |
| transport.rs | Transport trait、TCP 带超时 |
| serial_linux.rs | 串口（AsyncFd + termios raw） |
| serialdetect.rs | 串口自动探测（优先 ttyUSB1） |
| atclient.rs | 命令串行 100ms、2s 超时、2048 行上限、URC 分流、`abcd` 打断、重连 |
| pdu.rs | SMS PDU 解码（GSM7/UCS2/8bit/UDH），7 个单测全过 |
| notify.rs | 通知（日志/WebHook）、60s 合并、3 次重试 |
| urc.rs | 来电去重、CMTI→CMGR、长短信拼接、信号阈值、PDCP 14 字段 |
| schedconfig.rs | 定时锁频 DTO↔UCI 双写、校验、静态频段表 |
| schedule.rs | 昼夜锁频调度、无服务自动解锁、扫频宽限 60s |
| wsserver.rs | 认证/心跳/应答 FIFO/伪命令（CONNECT?/SCHED?/CELLSCAN）/Hub 广播 |

依赖：tokio、tokio-tungstenite、serde、serde_json、chrono、hex、ureq、libc、futures-util。
release 构建：`opt-level="s"`、LTO、panic=abort、strip（体积优先，适合 OpenWrt）；musl 静态链接（zig），无 glibc 依赖。

## 5. 构建

```sh
# Rust 后端（宿主验证用；OpenWrt 目标请用 SDK，见 docs/02）
cd src/rust
cargo build --release        # 产物 target/release/at-webserver
cargo test                   # 7/7 通过

# LuCI 插件（在 OpenWrt buildroot 中）
# 将本仓库（luci-app-mt5700）放入 feeds/luci/applications/，或作为独立包源
# 依赖 luci-base、luci-lib-nixio，Depends: at-webserver-rust
```

## 6. 测试结果（本机，2026-09-10）

- Rust：`cargo build` / `cargo build --release` 通过；`cargo test` **7/7** 通过。
- 端到端链路（tests/mock-modem，真实 Rust 后端 + mock 模组 + WS 客户端）：**22/22 通过**，
  覆盖认证（错误拒/正确过）、命令 FIFO、伪命令 CONNECT?/SCHED?/CELLSCAN、心跳、
  incoming_call / new_sms 结构化推送、错误处理。
- 前端解析层单测（载波聚合 / REJINFO / SIMSQ）：**19/19 通过**。
- 期间修复 Rust 后端 2 个真实缺陷：
  1. 空闲期模组主动上报被全部丢弃（与 Go 语义不一致）→ 已按 Go handleLine 修复；
  2. Hub 广播用 tokio RwLock::blocking_read 在异步任务内 panic → 改 std RwLock。
- 未执行（宿主无 SDK/硬件）：IPK/APK 实编译、真机安装、重启后功能、手机真机浏览 → 见 §8 云编译。

## 7. 快速开始（本机无硬件验证）

```sh
cd tests/mock-modem
npm install ws          # 仅测试依赖
sh run-e2e.sh           # 起 mock 模组 + Rust 后端 + 22 项端到端断言
node parse-extra-test.js   # 前端解析层 19 项单测
```

## 8. 云编译（GitHub Actions）

本仓库内置 `.github/workflows/build-openwrt.yml`，使用 OpenWrt 官方 `openwrt/sdk` 容器云编译，**无需本机 SDK**：

| 目标 | 包格式 | SDK 镜像 | 架构 |
|---|---|---|---|
| 最新主线（snapshot） | **`.apk`**（OpenWrt 24.10+ apk 包管理器） | `openwrt/sdk:*-main` | x86_64 / aarch64_cortex-a53 / mips_24kc |
| 老版本 23.05 | **`.ipk`**（opkg 兼容） | `openwrt/sdk:*-23.05.5` | x86_64 / aarch64_cortex-a53 / mips_24kc |

- **触发方式**：
  1. 手动：Actions 页面 → `Build OpenWrt packages (apk + ipk)` → `Run workflow`；
  2. 自动：push 到 `main` 分支；
  3. 发版：打标签 `git tag v1.0.0 && git push --tags` → 自动构建并发布 GitHub Release（含全部架构的 apk/ipk）。
- **产物获取**：每个构建行的 `Artifacts`（命名 `apk-<arch>` / `ipk-<arch>`）或 Release 附件。
- **Rust 交叉编译原理**：容器内 `rustup` 安装 Rust 工具链 + `zig` 作为 musl 交叉链接器
  （`scripts/sdk-build.sh` 按目标三元组动态生成 zig wrapper 与 cargo 全局配置），
  `scripts/sdk-build.sh` 将 `src/rust` 编译为 `at-webserver-rust` 包并连同 LuCI 插件一起打包。
- **扩展架构**：修改 workflow 的 `matrix` 增加行即可（镜像 tag 格式 `openwrt/sdk:<架构>-<版本>`（如 `x86_64-main`、`x86_64-23.05.5`），
  架构名需与 OpenWrt SDK 发布名一致；若 Rust 目标三元组未覆盖，先在 `src/rust/Makefile` 的
  `RUST_TARGET_*` 与 `scripts/sdk-build.sh` 的 zig target 映射中补充）。

## 9. 更多文档

- `docs/01-原WebUI功能清单与LuCI映射表.md` — 原 WebUI 8 页面 75 项功能 + 后端 B1-B16 → LuCI 页面/API 映射
- `docs/02-OpenWrt-SDK交叉编译与安装.md` — SDK 构建、IPK/APK 打包、安装/卸载、服务管理、Rust 交叉编译 target 表
- `docs/03-最终验收报告.md` — 验收结论、测试清单、未执行项如实说明
- `CHANGELOG.md` — 更新日志
