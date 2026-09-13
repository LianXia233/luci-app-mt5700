# AT WebServer · MT5700M 5G 模组管理

OpenWrt / ImmortalWrt 的 LuCI 插件，用于管理 MT5700M 5G 模组的拨号、网络状态、扫频、锁频、短信与 AT 调试。单包交付：前端 12 个页面与 Rust 后端 `/usr/bin/at-webserver-rust` 合并安装。

- 包名：`luci-app-mt5700`
- 配置段 / 服务：`at-webserver`
- 版本：v1.12.2
- 入口：LuCI 侧边栏「移动网络 → 5G 模组管理」（`admin/modem/5g`）

## 架构

LuCI 页面 → rpcd（ucode 代理 `mt5700.uc`）→ Rust 后端（tokio，TCP newline-JSON，仅回环 127.0.0.1）→ 模组 AT 命令。

- 默认连接 PCUI 串口 `/dev/ttyUSB1`，网络 TCP 为备用。
- 串口 / AT、定时锁频、小区扫频、企业微信推送等能力需常驻后端进程，故安装包内含后端二进制。

## 功能

12 个管理页面（`htdocs/luci-static/resources/view/at-webserver/`）：

网络状态 · 网络设置 · 拨号设置 · 全网扫频 · 定时锁频 · 模组设置 · 模组升级 · 短信中心 · 短信设置 · AT 调试终端 · 通知日志 · 服务配置

## 安装

从 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载与目标架构匹配的包（前端与后端必须成对安装）。

### OpenWrt 24.10+（apk）

```sh
apk add --allow-untrusted \
  ./aarch64_cortex-a53-luci-app-mt5700-1.12.2-r1.apk \
  ./aarch64_cortex-a53-luci-i18n-mt5700-zh-cn-*.apk
```

### OpenWrt 23.05（opkg / ipk）

```sh
opkg install ./aarch64_cortex-a53-luci-app-mt5700_1.12.2_aarch64_cortex-a53.ipk
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
├── Makefile                   # 包定义（PKG_VERSION=1.12.2）
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

[MIT](LICENSE)
