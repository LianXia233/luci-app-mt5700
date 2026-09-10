# AT WebServer（MT5700M 5G 模组）— LuCI + Rust 管理界面

> OpenWrt 插件包：`luci-app-mt5700`（仓库根即 LuCI 插件包，Rust 后端位于 `src/rust/`；
> 服务名与 UCI 段名沿用 `at-webserver`，保持既有配置兼容）。

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
│   ├── 01-原WebUI功能清单与LuCI映射表.md   # 功能 → LuCI 页面/API 完整映射（8 页 75 项功能 + 后端 B1-B16）
│   ├── 02-OpenWrt-SDK交叉编译与安装.md      # SDK 构建、IPK/APK 打包、安装/卸载、交叉编译
│   └── 03-最终验收报告.md                   # 验收结果与未执行项说明
├── htdocs/luci-static/resources/
│   ├── at-webserver/                   # 公共库：rpc.js / parse.js / ui.js / smsEncode.js / at.css
│   └── view/at-webserver/              # 12 个页面 JS
├── po/                                 # 翻译（templates + zh_Hans）
├── root/
│   ├── etc/config/at-webserver         # UCI 默认配置
│   ├── etc/init.d/at-webserver         # procd 服务脚本
│   ├── etc/uci-defaults/at-webserver   # 首次安装初始化
│   ├── usr/share/luci/menu.d/          # 顶部菜单（网络 / 服务 两个顶级入口）
│   └── usr/share/rpcd/
│       ├── acl.d/luci-app-mt5700.json  # 权限控制（含 mt5700 RPC 对象）
│       └── ucode/mt5700.uc             # rpcd ucode 插件（LuCI RPC ↔ Rust 代理）
├── src/rust/                           # Rust 后端（独立包 at-webserver-rust）
│   ├── Makefile                        # OpenWrt 包 Makefile（cargo + zig 交叉编译）
│   ├── Cargo.toml
│   └── src/                            # 13 个源文件（见 §4）
└── tests/mock-modem/                   # 本地链路验证（无硬件环境）
    ├── mock-modem.js                   # MT5700 AT 模组模拟器（TCP 20249）
    ├── mock-uci                        # 假 uci（测试配置注入）
    ├── e2e-test.js                     # RPC 端到端测试（20 项）
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
               LuCI RPC（L.rpc.declare）
                    │
             ┌──────▼──────┐
             │     rpcd     │  ucode 插件 mt5700.uc（/usr/share/rpcd/ucode/）
             └──────┬──────┘
                    │  TCP newline-JSON（仅 127.0.0.1）
             ┌──────▼──────┐
             │ Rust Backend│  tokio：RpcServer + AtClient + Dispatcher + Scheduler
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

- **LuCI RPC 直连，无 WebSocket**：页面 JS 用 `L.rpc.declare` 调用 rpcd 对象 `mt5700`（`at` 执行 AT 命令、
  `events` 拉取事件增量）；rpcd ucode 插件把请求转发给 Rust 后端（仅回环 127.0.0.1，不对外暴露端口）。
- **实时状态**：Rust 维护事件总线（raw_data / new_sms / incoming_call / pdcp_data / memory_full /
  cellscan / urc_data 带单调 seq），前端订阅后按 1.5s 轮询 `events(since)` 拉取增量；
  命令应答 `{success,data,error}` 逐条独立，前端仍按发送顺序串行化。
- **认证**：LuCI 登录态由 rpcd 会话/ACL 保证；UCI `websocket_auth_key` 由 ucode 代理自动附带，
  密钥配置语义保持兼容；页面无需再输密钥。
- 服务配置页同时用 LuCI UCI API 与 ubus（service reload/restart、日志文件）。

## 3. 功能等价性

- 既有 8 个页面全部迁移，见 `docs/01-原WebUI功能清单与LuCI映射表.md`（功能 1-75、后端 B1-B16）。
- 菜单：原有侧边栏 8 项映射为 LuCI **网络 → 5G 模组**（网络状态/网络设置/拨号设置/全网扫频/定时锁频）
  与 **服务 → 5G 模组**（模组设置/模组升级/短信中心/短信设置/AT调试终端/通知日志/服务配置），无入口丢失。
- 全部按钮 → JS → LuCI RPC → Rust → 模组 → 应答 → UI 更新链路真实（见 §6 测试结果）。
- **未实现项已清零**：全部功能（含载波辅助小区聚合 `^MONSSC`/`^CASCELLINFO`、`^REJINFO` 网络拒绝原因面板、
  `^SIMSQ` 卡状态、连接诊断面板、温度保护阈值等深层功能）均已完整移植，见 `docs/03-最终验收报告.md`。
- 如实说明：OpenWrt SDK 交叉编译 / IPK·APK 实编译 / 真机安装 / 重启后功能 / rpcd ucode 真机代理，
  需在带 SDK 的环境（推荐 **GitHub Actions 云编译**，见 §8）或真机上执行。

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
| rpcserver.rs | LuCI RPC 服务（TCP newline-JSON）、伪命令 CONNECT?/SCHED?/CELLSCAN、事件总线、扫频状态机 |

依赖：tokio、serde、serde_json、chrono、hex、ureq、libc、async-trait。
release 构建：`opt-level="s"`、LTO、panic=abort、strip（体积优先，适合 OpenWrt）；musl 静态链接（zig），无 glibc 依赖。

## 5. 构建

```sh
# Rust 后端（宿主验证用；OpenWrt 目标请用 SDK，见 docs/02）
cd src/rust
cargo build --release        # 产物 target/release/at-webserver
cargo test                   # 7/7 通过

# LuCI 插件（在 OpenWrt buildroot 中）
# 将本仓库（luci-app-mt5700）放入 feeds/luci/applications/，或作为独立包源
# 依赖 luci-base、luci-lib-nixio、rpcd-mod-ucode，Depends: at-webserver-rust
```

## 6. 测试结果（本机，2026-09-10）

- Rust：`cargo build` / `cargo build --release` 通过（0 warning）；`cargo test` **7/7** 通过。
- 端到端链路（tests/mock-modem，真实 Rust 后端 + mock 模组 + RPC 客户端）：**20/20 通过**，
  覆盖认证（错误密钥拒/正确通过）、命令应答、伪命令 CONNECT?/SCHED?/CELLSCAN、
  events 增量拉取、incoming_call / new_sms / REJINFO(raw_data) 事件、MONSSC/CASCELLINFO/SIMSQ。
- 前端解析层单测（载波聚合 / REJINFO / SIMSQ）：**19/19 通过**。
- 期间修复 Rust 后端 2 个真实缺陷：
  1. 空闲期模组主动上报被全部丢弃（与 Go 语义不一致）→ 已按 Go handleLine 修复；
  2. 广播用 tokio RwLock::blocking_read 在异步任务内 panic → 改 std 锁 + 非阻塞入队。
- 未执行（宿主无 SDK/硬件/OpenWrt）：IPK/APK 实编译、真机安装、rpcd ucode 真机代理、
  重启后功能、手机真机浏览 → 见 §8 云编译。

## 7. 快速开始（本机无硬件验证）

```sh
cd tests/mock-modem
npm install ws          # 仅测试依赖（e2e 使用 node 内置 net，ws 保留备用）
sh run-e2e.sh           # 起 mock 模组 + Rust 后端 + 20 项端到端断言
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
- **扩展架构**：修改 workflow 的 `matrix` 增加行即可（镜像 tag 格式 `openwrt/sdk:<架构>-<版本>`，
  架构名需与 OpenWrt SDK 发布名一致；若 Rust 目标三元组未覆盖，先在 `src/rust/Makefile` 的
  `RUST_TARGET_*` 与 `scripts/sdk-build.sh` 的 zig target 映射中补充）。

## 9. 更多文档

- `docs/01-原WebUI功能清单与LuCI映射表.md` — 功能 1-75 + 后端 B1-B16 → LuCI 页面/API 映射
- `docs/02-OpenWrt-SDK交叉编译与安装.md` — SDK 构建、IPK/APK 打包、安装/卸载、服务管理、Rust 交叉编译 target 表
- `docs/03-最终验收报告.md` — 验收结论、测试清单、未执行项如实说明
- `CHANGELOG.md` — 更新日志
