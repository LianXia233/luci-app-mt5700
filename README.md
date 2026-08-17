# luci-app-mt5700m

MT5700M 蜂窝模块管理 LuCI 应用（OpenWrt / ImmortalWrt）。提供 AT 指令终端（WebSocket）、
短信、流量统计、信号/小区信息（RSSI/SINR/PCI/CA/速率/温度）实时面板，以及企微机器人通知。

> 仓库部署名 `luci-app-mt5700`；包名与设备侧服务名仍为 `luci-app-mt5700m`（WebUI / UCI / procd 均按此名称寻址）。

[![Build & Release](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/build.yml/badge.svg)](https://github.com/LianXia233/luci-app-mt5700/actions/workflows/build.yml)

---

## 1. 特性

| 模块 | 说明 |
|---|---|
| AT WebSocket 终端 (`at-server`) | 浏览器直连模块串口 / 网络 AT 端口的双向终端，心跳保活、命令分发 |
| 短信 (SMS) | PDU / text 收发，GSM-7 / UCS2 解码 |
| 流量统计 (`mt5700m-traffic`) | 周期性采样、落盘 `traffic-history`、守护采样 |
| 信号面板 | RSSI / RSRP / SINR / PCI / 载波聚合(CA) / 上下行速率 / 温度实时展示 |
| 企微通知 | Rust 后端通过 `curl` 调企微机器人 Webhook 推送事件（HTTPS） |
| 双包格式 | 同时产出 **opkg (`.ipk`)** 与 **apk (`.apk`)**，覆盖 OpenWrt 24.10 与 25.x |

---

## 2. 架构

后端是一个 **单一 Rust 二进制 `mt5700m`**，按 `argv[0]` 基名派发，对外表现为多个程序：

```
/usr/bin/mt5700m          # 本体（Rust, std-only, 零外部 crate）
/usr/bin/at-server        # -> mt5700m  (argv[0] == "at-server"  => server::run)
/usr/sbin/mt5700m-at      # -> mt5700m  (at 指令封装, 仍由 Shell 前端调用)
/usr/sbin/mt5700m-manager # -> mt5700m  (状态/日志/连接/高级设置 JSON-RPC 后端)
/usr/sbin/mt5700m-traffic # -> mt5700m  (流量统计)
```

- **零外部依赖**：自研 RFC6455 WebSocket、SHA1+Base64、GSM-7/UCS2 PDU 解码、双栈 `TcpListener`；
  企微 Webhook 走 `curl` shell-out，避开 TLS 栈。
- **派发契约**：`at-server` 软链到 `mt5700m`，`/etc/init.d/at-webserver` 启动即拉起 WebSocket 终端，
  与旧 Python 实现行为一致。
- **Shell 前端保留**：`mt5700m-at` / `-manager` / `-traffic` 仍是 Shell 脚本（rpcd 与 init 依赖其富子命令），
  后续将逐步迁移为 Rust 符号链接（见 §7）。

前端（`htdocs/5700`）是预构建的 UMI/Webpack SPA，已随包发布；为避免 LuCI 的 `jsmin` 破坏正则字面量，
包内已设 `LUCI_MINIFY_JS:=0`。

---

## 3. 支持的目标

| 架构 | musl 三元组 | 典型设备 |
|---|---|---|
| x86_64 | `x86_64-unknown-linux-musl` | x86 软路由 |
| aarch64 (ARM64) | `aarch64-unknown-linux-musl` | MT5700M、ARM 盒子 |
| ARMv7 | `armv7-unknown-linux-musleabihf` | Cortex-A9 等 |
| MIPS (little-endian) | `mipsel-unknown-linux-musl` | ramips 等 |
| MIPS (big-endian) | `mips-unknown-linux-musl` | 老 MIPS |
| i686 | `i686-unknown-linux-musl` | 32 位 x86 |

OpenWrt 版本：**24.10.x（opkg/.ipk）** 与 **25.x（apk/.apk）**；更早版本（23.05）可按需扩展矩阵。

---

## 4. 安装

### 4.1 从 Releases（推荐）

1. 到 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载对应架构与包格式的产物。
2. 上传到路由器后安装：

   ```sh
   # opkg (.ipk, OpenWrt 24.10)
   opkg install luci-app-mt5700m_*.ipk

   # apk (.apk, OpenWrt 25.x)
   apk add --allow-untrusted luci-app-mt5700m_*.apk
   ```

3. 依赖 `luci-base`、`ubus-at-daemon`、`sms-tool_q`、`curl` 需已在设备或自定义 feed 中可用。

### 4.2 从源码（OpenWrt SDK / 本地）

```sh
# 1) 准备 Rust 工具链（交叉目标）
rustup target add aarch64-unknown-linux-musl   # 按目标架构选择三元组

# 2) 用 OpenWrt SDK 编译（在 SDK 环境下）
./scripts/feeds update -a
./scripts/feeds install luci-app-mt5700m
make package/luci-app-mt5700m/compile V=s
```

本地编译时 `Build/Compile` 会直接 `cargo build`（需 SDK 环境内有 `cargo` 与目标 `rust-std`）；
CI 则改为注入预编译二进制（见 §6）。

---

## 5. 配置（UCI）

```sh
uci set at-webserver.config.enabled='1'
uci set at-webserver.config.websocket_port='8765'
uci commit at-webserver
/etc/init.d/at-webserver restart
```

`mt5700m-traffic` 的持久化文件位于 `/etc/mt5700m/traffic-history`（已在 `conffiles` 中声明）。

---

## 6. CI / 云端自动编译

`.github/workflows/build.yml` 实现：

1. **rust 作业**：在 GitHub  runner 上用自带 `rust-lld`（自包含链接，无需交叉 gcc）为 6 个 musl 目标
   编译 `mt5700m`，产物作为 artifact 上传。
2. **openwrt 作业**（矩阵 = 架构 × SDK 版本）：下载预编译二进制，置入包目录，调用
   [`openwrt/gh-action-sdk`](https://github.com/openwrt/gh-action-sdk) 用官方 SDK 容器打包。
   - `24.10.8` → 产出 `.ipk`（opkg）
   - `25.12.5` → 产出 `.apk`（apk 包管理器）
3. **release 作业**：汇集全部 `.ipk` / `.apk`，计算 SHA256，推送到 GitHub Releases。

触发方式：

- 推送 tag `v*`：自动构建并发布 Release。
- `workflow_dispatch`（填写 `release_tag`）：手动构建并发布。
- 发起 PR：仅构建验证，不发布。

> 提示：若你的自定义依赖（`ubus-at-daemon`、`sms-tool_q`）不在默认 feed，可在工作流中为
> `openwrt/gh-action-sdk` 设置 `EXTRA_FEEDS`；这些仅为运行时依赖，不影响包本身的编译。

---

## 7. 已知边界 / 路线图

- `mt5700m-at` / `-manager` / `-traffic` 仍为 Shell 实现（rpcd / init 依赖其富子命令），
  迁移为 Rust 符号链接前需先做命令级等价性验证并回归 LuCI 面板。
- CI 矩阵中的架构 / SDK 版本可按需增删；若某 SDK 容器标签不存在，构建会拉取失败，按
  [OpenWrt Releases](https://github.com/openwrt/openwrt/releases) 调整版本号即可。
- 本仓库 `.gitattributes` 强制 LF 行尾——`Makefile` 的 `Build/Compile` 使用 `\` 续行，
  续行前若出现 CR 会导致 GNU make 漏掉续行、破坏 Rust 构建。

---

## 8. 目录结构

```
luci-app-mt5700m/
├── Makefile                 # OpenWrt 包定义 + RUST_TARGET 架构映射 + Build/Compile
├── mt5700m-rs/              #  vendored Rust 后端（Cargo.toml / src / REFACTOR.md）
├── root/                    #  设备侧文件（init.d, uci-defaults, bin, config.json 等）
├── htdocs/5700/             #  预构建前端 SPA
├── po/                      #  翻译
└── .github/workflows/       #  CI
```

---

## 9. 许可

Apache-2.0。
