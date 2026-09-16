# AT WebServer · MT5700M 5G 模组管理

OpenWrt / ImmortalWrt 的 LuCI 插件，用于管理 MT5700M 5G 模组的拨号、网络状态、扫频、锁频、短信与 AT 调试。单包交付：前端 12 个页面与 Rust 后端 `/usr/bin/at-webserver-rust` 合并安装。

- 包名：`luci-app-mt5700`
- 配置段 / 服务：`at-webserver`
- 版本：v1.12.4
- 入口：LuCI 侧边栏「移动网络 → 5G 模组管理」（`admin/modem/5g`）

## 架构

LuCI 页面 → rpcd（ucode 代理 `mt5700.uc`）→ Rust 后端（tokio，TCP newline-JSON，仅回环 127.0.0.1）→ 模组 AT 命令。

- 默认连接 PCUI 串口 `/dev/ttyUSB1`，网络 TCP 为备用。
- 串口 / AT、定时锁频、小区扫频、企业微信推送等能力需常驻后端进程，故安装包内含后端二进制。

## 功能

12 个管理页面（`htdocs/luci-static/resources/view/at-webserver/`）：

网络状态 · 网络设置 · 拨号设置 · 全网扫频 · 定时锁频 · 模组设置 · 模组升级 · 短信中心 · 短信设置 · AT 调试终端 · 通知日志 · 服务配置

## 与 luci-app-mt5700m 的区别

本仓库与同系列的 [`luci-app-mt5700m`](https://github.com/LianXia233/luci-app-mt5700m) 都面向 MT5700M-CN 5G 模组，但技术路线不同，按场景选用：

| 维度 | luci-app-mt5700（本仓库） | luci-app-mt5700m |
|:--|:--|:--|
| 后端实现 | Rust 后端 `at-webserver-rust` 随包内置，单包交付 | 纯 LuCI（JS），依赖外部 `ubus-at-daemon` 守护进程与 `sms-tool_q` |
| 通信架构 | LuCI → rpcd（ucode 代理 `mt5700.uc`）→ Rust → 模组 AT | LuCI → ubus（at-daemon / sms-tool_q）→ 模组 |
| 拨号方式 | PCUI 串口 AT（`SERIAL`，默认 `/dev/ttyUSB1`，TCP 备用） | NCM 拨号（依赖 `kmod-usb-net-cdc-ncm` 等内核模块） |
| 功能侧重 | 扫频、定时锁频、企业微信推送、通知日志（含 12 页全功能管理） | 概览、移动数据、网络与小区、短信、系统维护、流量历史 |
| 版本 / 许可 | v1.12.4 / GPLv3 | 2.x / Apache-2.0 |

> **两个插件互不兼容：** 二者都直接接管同一 MT5700M 模组的控制通道（AT/串口）与数据接口，同一台设备上同时安装会争用通道、造成配置冲突，因此管理同一模组时只能二选一，不可同时启用。

选型：需要扫频 / 锁频 / 常驻后端管控时选本仓库；偏好纯 LuCI、NCM 拨号、配套原版 WebUI 的选 `luci-app-mt5700m`。

## 安装

从 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载与目标架构匹配的包（前端与后端必须成对安装）。

### OpenWrt 24.10+（apk）

```sh
apk add --allow-untrusted \
  ./aarch64_cortex-a53-luci-app-mt5700-1.12.4-r1.apk \
  ./aarch64_cortex-a53-luci-i18n-mt5700-zh-cn-*.apk
```

### OpenWrt 23.05（opkg / ipk）

```sh
opkg install ./aarch64_cortex-a53-luci-app-mt5700_1.12.4_aarch64_cortex-a53.ipk
opkg install ./aarch64_cortex-a53-luci-i18n-mt5700-zh-cn_*.ipk
```

## 快速开始

```sh
uci set at-webserver.config.enabled=1
uci set at-webserver.config.connection_type=SERIAL   # 默认 PCUI
uci set at-webserver.config.serial_port=auto         # 优先探测 ttyUSB1
uci commit at-webserver
service at-webserver restart

# 确认后端随包安装
ls -l /usr/bin/at-webserver-rust
```

登录 LuCI 后进入「移动网络 → 5G 模组管理」即可使用 12 个页面。

## 开机自启

前端与后端均随系统开机自动就绪，无需手动配置：

- **后端（Rust 服务）**：服务由本包自带的 `root/etc/uci-defaults/at-webserver`（首次启动执行）与 Makefile `postinst`（安装/升级执行）**显式** `enable`，创建开机软链接 `/etc/rc.d/S99at-webserver`；开机后按 `START=99` 经 procd 拉起 `/usr/bin/at-webserver-rust`（带 respawn 守护）。是否真正启动由 UCI `at-webserver.config.enabled` 控制（默认 `1`）。

  > 注意：OpenWrt **不会**替包自动 enable init 服务，必须显式执行 `enable`。
  > 早期版本曾因 `root/etc/init.d/at-webserver` 执行位回退（100755 → 100644）
  > 导致安装期 enable 以 `Permission denied` 失败；而 enable 只在安装那一刻执行
  > 一次、失败不重试，于是存量设备永久停留在「未注册」状态——重启后服务再也不起来。
  > 为此 `start_service` 内置自愈：每次 start 若发现 `/etc/rc.d` 链接缺失就自动补 `enable`，
  > 存量设备执行一次 `/etc/init.d/at-webserver start` 即永久修好。

- **前端（LuCI 页面）**：页面与菜单（`menu.d`）、权限（`acl.d`）随 rpcd / uhttpd 系统服务自动加载；RPC 代理 `mt5700.uc` 由 rpcd 启动时扫描 `/usr/share/rpcd/ucode/` 自动注册，无独立进程需要管理。
- **网络接口**：服务启动时会将 `MT5700M` / `MT5700Mv6` 接口置为 `auto=1` 并在模组网口就绪后主动 `ifup`，保证拨号接口开机自启。

排查命令：

| 检查项 | 命令 | 预期 |
|:--|:--|:--|
| 开机自启注册 | `ls -l /etc/rc.d/ \| grep at-webserver` | 存在 `S99at-webserver` |
| 注册状态 | `/etc/init.d/at-webserver enabled && echo yes` | 输出 `yes` |
| 运行状态 | `service at-webserver status` | `running` |
| procd 实例 | `ubus call service list '{"name":"at-webserver"}'` | `instance1.running = true` |
| 启动日志 | `logread -e at-webserver` | 无 `Permission denied` / `enable 失败` |

页面显示「未注册」时的手动修复：`/etc/init.d/at-webserver enable && /etc/init.d/at-webserver start`。

## UCI 配置

配置文件：`/etc/config/at-webserver`。常用键：

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `config.enabled` | `1` | 启用服务 |
| `config.connection_type` | `SERIAL` | 连接类型，默认 PCUI 串口 |
| `config.serial_port` | `auto` | 串口设备，自动探测优先 `ttyUSB1` |
| `config.autodial_enable` | `1` | 连上模组后确保开启自动拨号 |
| `config.autodial_mode` | `1` | 1=USB 网络接口，2=转网口模式 |

页面修改采用暂存式「保存并应用」：改动控件后点击「保存并应用」才写入并生效（`uci changes → save → apply`；无待应用变更时视为已生效）。

## 项目结构

```
luci-app-mt5700/
├── Makefile                   # 包定义（PKG_VERSION=1.12.4）
├── htdocs/luci-static/resources/
│   ├── view/at-webserver/     # 12 个页面 JS
│   └── at-webserver/          # rpc.js / ui.js / at.css 等前端资源
├── root/
│   ├── etc/config/at-webserver
│   ├── etc/init.d/at-webserver
│   ├── etc/uci-defaults/at-webserver
│   └── usr/share/
│       ├── luci/menu.d/luci-app-mt5700.json
│       └── rpcd/acl.d/luci-app-mt5700.json
├── src/Makefile               # 顺带 cargo build 后端
├── src/rust/                  # Rust 后端（Cargo 版本 1.5.0）
├── po/                        # 翻译模板与 zh_Hans
└── tests/mock-modem/          # 测试用 mock 模组
```

## 云编译与发布

GitHub Actions（`.github/workflows/build-openwrt.yml`）对每个推送做云编译：

- 主线（snapshot）→ apk；23.05 → ipk
- 架构矩阵：x86_64 / aarch64_cortex-a53 / mips_24kc
- 编译成功自动发布 [Release](https://github.com/LianXia233/luci-app-mt5700/releases)

## 许可证

[GNU General Public License v3.0](LICENSE)
