# luci-app-mt5700 `Debian` 分支

MT5700M 5G 模组管理服务的 **Debian 独立版**：将原 LuCI 应用完整迁移为可独立运行于
Debian 的 WebUI + HTTP API 服务，移除对 LuCI / ubus / rpcd / UCI / netifd 等
OpenWrt 专属组件的全部依赖。

原 OpenWrt/LuCI 版本保留在 `main` 分支，本分支不回改其任何代码。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 功能

与 `main` 分支功能一致：

- 设备状态、网络信息、信号参数（RSRP/RSRQ/SINR/RSSI）、温度监控
- SIM/IMEI、运营商、频段与载波信息
- 连接状态、拨号设置（APN/自动拨号）、流量统计（PDCP + 接口计数）
- 全网扫频（异步任务，支持取消）、定时锁频（夜间/日间自动倒换）
- 短信中心（收发/删除/导出）、短信设置、USSD
- 模组设置、固件升级（FOTA）、AT 调试终端、运行日志
- 短信/来电/信号通知与企业微信 WebHook 推送

## 架构

```
浏览器 ──HTTP(9000)──> at-webserver (Rust)
   │                      ├── httpserver.rs   HTTP API + WebSocket + 静态 WebUI
   │                      ├── rpcserver.rs    TCP newline-JSON RPC（保留，e2e/调试用）
   │                      ├── atclient.rs     AT 客户端（串口/网络，接口独占 + 优先级队列）
   │                      ├── schedule.rs     定时锁频调度
   │                      ├── urc.rs          主动上报分发（短信/来电/URC 事件总线）
   │                      └── state.rs        状态缓存（后台预热，毫秒级响应）
   └── WebSocket /ws        事件实时推送（短信/来电/扫频进度/URC）
```

要点：

- **前后端解耦**：WebUI（`webui/`）是纯静态资源，由后端直接托管；所有业务数据
  经 HTTP API（`/api/*`）与 WebSocket（`/ws`）通信。
- **AT 通道独占**：所有 AT 命令经后端统一队列串行下发（用户操作 High 优先级、
  后台刷新 Low 优先级），WebUI 加载与页面操作永不阻塞。
- **实时机制**：事件总线（单调递增 seq）+ 前端增量轮询 `/api/events?since=` 与
  WebSocket `/ws` 推送并存。
- **LuCI 兼容垫片**：原 12 个 LuCI 视图文件经 `webui/luci.js` 垫片原样复用，
  界面风格、布局、交互与 OpenWrt 版一致。

## 目录结构

```
webui/                     独立 WebUI（静态资源）
  ├── index.html           入口
  ├── app.js               路由 + 模块加载器
  ├── luci.js              LuCI 兼容垫片（L.rpc/L.uci/L.fs/E）
  ├── shell.css            外壳样式
  ├── _layout-test/        布局回归样张（脱离后端静态预览栅格）
  └── luci-static/...      原视图与组件（仅 rpc.js 配置流程、service.js Debian 化）
src/rust/                  后端（Rust + tokio）
  ├── httpserver.rs        HTTP API + WebSocket（新增）
  ├── configstore.rs       JSON 配置存储，替代 UCI（新增）
  ├── config.rs            配置读取（改为文件，键名沿用原 UCI 语义）
  ├── rpcserver.rs         TCP RPC（保留）+ 核心业务入口
  └── ...                  AT 队列/扫频/调度/通知等（与 main 分支一致）
debian/
  ├── at-webserver.service systemd 服务单元
  ├── config.json          默认配置（安装到 /etc/mt5700/config.json）
  ├── on-uplink.sh         拨号就绪钩子（DHCP 拉起模组网口）
  ├── install.sh           一键编译安装（源码方式）
  ├── build-deb.sh         构建 .deb 包（CI 与本地共用）
  └── ci-verify.sh         本地模拟 CI 闸门（不开 Actions 时验证产物）
.github/workflows/
  └── build-deb.yml        云编译工作流（amd64 + arm64 → deb → Release）
tests/mock-modem/          mock 模组 e2e 测试（TCP RPC 通道）
```

> **前端无构建步骤**：`webui/` 为手写源码，由 `install.sh` 直接复制到 `/usr/share/mt5700/webui`
> 并由后端 `serve_static()` 原样返回。因此浏览器拿到的 JS/CSS **始终是未压缩源码**，
> 排查问题时可直接阅读页面加载到的文件内容。

## 部署（Debian 11+）

### 方式一：安装 deb 包（推荐）

从 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载对应架构的
`at-webserver_<版本>-<修订>_<架构>.deb`：

```bash
# 树莓派 / ARM 工控机
sudo apt install ./at-webserver_2.0.0-1_arm64.deb

# PC / x86 虚拟机
sudo apt install ./at-webserver_2.0.0-1_amd64.deb
```

`apt` 会自动处理依赖解析与服务注册（`postinst` 中 `daemon-reload` + `enable` + `start`）。

> **未接模组也能安装**：服务启动失败不会中断安装（`postinst` 已容错），日志提示后
> 待模组接入再 `sudo systemctl restart at-webserver` 即可。配置文件 `/etc/mt5700/config.json`
> 为 **conffile**，升级时保留用户修改；彻底卸载用 `sudo apt purge at-webserver`。

### 方式二：源码安装（自行编译）

```bash
sudo apt install -y build-essential pkg-config curl
sudo ./debian/install.sh
```

脚本执行：编译 `src/rust` → 安装二进制与 WebUI → 写入配置与 systemd 单元 →
`systemctl enable --now at-webserver`。

支持 `--bin` 跳过编译、`--no-deps` 跳过依赖检测：

```bash
sudo ./debian/install.sh --bin /path/to/at-webserver
```

### 手动部署

```bash
cd src/rust && cargo build --release
sudo install -m 0755 target/release/at-webserver /usr/bin/at-webserver
sudo mkdir -p /usr/share/mt5700 && sudo cp -r ../../webui /usr/share/mt5700/webui
sudo mkdir -p /etc/mt5700
sudo cp ../../debian/config.json /etc/mt5700/config.json
sudo cp ../../debian/at-webserver.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now at-webserver
```

### 本地打包 deb

不依赖 CI，本地即可构建与安装：

```bash
# 编译 + 打包（当前机器架构，amd64 机器上即 amd64 包）
debian/build-deb.sh

# 已有二进制直接打包（架构由 ELF 自动判定）
debian/build-deb.sh --bin src/rust/target/release/at-webserver

# 指定修订号（默认 1）
debian/build-deb.sh --revision 2
```

> **本地打 arm64 包需要交叉工具链**：CI 已改用 GitHub 原生 arm runner，但在 x64 机器上
> 本地交叉打 arm64 包仍需 `gcc-aarch64-linux-gnu`：
>
> ```bash
> sudo apt install -y gcc-aarch64-linux-gnu
> export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
> export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
> cargo build --release --target aarch64-unknown-linux-gnu
> debian/build-deb.sh --bin src/rust/target/aarch64-unknown-linux-gnu/release/at-webserver
> ```
>
> 若你手上有 arm64 机器（树莓派等），直接在该机器上 `debian/build-deb.sh` 即可产出
> 原生 arm64 包，无需交叉工具链。

产物位于 `dist/`：`at-webserver_<版本>-<修订>_<架构>.deb`。

打包脚本的两个关键设计：

- **版本单一来源**：取自 `src/rust/Cargo.toml` 的 `version`，与后端二进制版本天然一致，
  不会出现「包版本与二进制版本不符」。
- **架构自 ELF 判定**：从产物二进制读取 ELF Machine 字段判定架构，而非信任
  `dpkg --print-architecture`。交叉编译场景下后者给出的是宿主架构，会产出
  `Architecture: amd64` 却内含 arm64 二进制的坏包（该包在 arm64 设备上会被 dpkg 拒绝）。
- **依赖动态推导**：读 `objdump -p` 的 `NEEDED` 条目映射到 Debian 包名并去重，不硬编码
  依赖清单，避免虚报或漏报。

### 开箱即用

启动后浏览器访问：

```
http://<设备IP>:9000
```

默认配置：串口 `auto`（自动探测 PCUI 口，优先 `/dev/ttyUSB1`）、波特率 115200、
监听 `0.0.0.0:9000`、无认证密钥。

## 配置

配置文件 `/etc/mt5700/config.json`（JSON 扁平键值，键名沿用原 UCI 语义）。
修改后两种生效方式：

1. **热应用**：WebUI「服务配置 → 保存并应用」或 `POST /api/config/apply`。
   `schedule_*`、通知开关等即时生效；
2. **重启**：结构性配置（连接类型/串口/端口/密钥等）需重启，
   WebUI 会提示；后端退出后由 systemd 自动拉起。

常用键：

| 键 | 说明 | 默认值 |
| --- | --- | --- |
| `connection_type` | `SERIAL`（PCUI 串口）/ `NETWORK`（TCP） | `SERIAL` |
| `serial_port` | 串口路径，`auto` 为自动探测 | `auto` |
| `serial_baudrate` | 波特率 | `115200` |
| `http_port` / `http_bind` | WebUI 监听端口/地址 | `9000` / `0.0.0.0` |
| `auth_key` | 访问密钥（设置后 API/WS 均需携带） | 空（不启用） |
| `web_root` | WebUI 静态目录 | `/usr/share/mt5700/webui` |
| `netdev` | 流量统计接口（空为自动识别 USB 网口） | 空 |
| `log_file` | 通知日志路径 | `/tmp/at-notifications.log` |
| `schedule_enabled` | 定时锁频总开关 | `0` |

环境变量：`MT5700_CONFIG`（配置文件路径）、`MT5700_WEBROOT`（WebUI 目录）、
`MT5700_UPLINK_HOOK`（拨号钩子路径）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/at` `{cmd}` | 执行 AT 命令 |
| GET | `/api/events?since=N` | 增量事件 |
| GET | `/api/logs?since=&limit=` | 后端运行日志 |
| GET | `/api/netrate?device=` | 接口累计字节数（sysfs，不占 AT 通道） |
| GET | `/api/usb` | 模组 USB 链路速率 |
| GET | `/api/syslog?lines=` | 系统日志（journalctl） |
| GET/POST | `/api/config` | 配置读取 / 合并落盘 |
| POST | `/api/config/apply` | 热应用，返回 `restart_required` |
| GET | `/api/service/status` | 服务状态 / 串口清单 |
| POST | `/api/service/restart` | 重启（systemd 拉起） |
| GET | `/ws` | WebSocket 事件推送 |

认证：设置 `auth_key` 后，请求头携带 `X-Auth-Key: <key>`（WS 可用 `?key=`）。

## 构建 / 测试

```bash
cd src/rust
cargo build --release
cargo test
```

### 云编译（GitHub Actions）

推送 `Debian` 分支或打 `debian-v*` 标签即自动编译并发布 Release：

```
GitHub Actions → Debian 软件包云编译（deb）
  ├─ 编译打包（amd64 · ubuntu-24.04）      官方 x64 runner，原生编译
  ├─ 编译打包（arm64 · ubuntu-24.04-arm）  官方原生 arm64 runner，原生编译
  └─ 统一发布             汇总两架构产物 → Release
```

两个架构均使用 GitHub 官方**原生** runner，arm64 由 arm64 机器（Cobalt 100 / Arm
Neoverse N2，4 vCPU）直接编译，不走 x64 交叉编译：

- 无需注入交叉链接器与 `AR`，配置面更小、失败点更少；
- 产物由 arm64 原生工具链产出，不经交叉翻译层，可信度与兼容性更佳；
- `ring`（`ureq`/rustls 的 TLS 后端）需要 C 编译器与汇编器，原生 runner 自带 gcc。

> **前置条件：仓库必须为 public。** GitHub 的 `ubuntu-*-arm` 免费标签仅对公开仓库开放；
> 仓库转为 private 后该标签不被调度，workflow 将直接失败（不会静默降级）。工作流内的
> 「runner 架构闸门」会显式校验 `uname -m` 与目标架构是否匹配，防止误配静默产出错包。

产物命名：`at-webserver_<Cargo版本>-<修订>_<架构>.deb`。
可用 Actions 页面手动触发并指定修订号（默认 `1`）。

本地不开 Actions 时，可用等价脚本验证同一套闸门：

```bash
bash debian/ci-verify.sh x86_64-unknown-linux-gnu amd64
bash debian/ci-verify.sh aarch64-unknown-linux-gnu arm64
```

mock 模组 e2e（TCP RPC 兼容通道）：见 `tests/mock-modem/run-e2e.sh`。

前端解析层单测（Node 环境，无需浏览器与后端）：

```bash
cd tests/mock-modem
node hcsq-test.js         # ^HCSQ / ^MONSC 字段解析（28 项）
node parse-extra-test.js  # 辅载波聚合 / REJINFO / SIMSQ（19 项）
node temp-level-test.js   # 模组温度 6 档分级（26 项）
```

## 布局回归样张

网络状态页底部卡片区的栅格排版可脱离后端静态预览（无需连接模组）：

```
http://<host>:9000/_layout-test/status-mock.html
```

样张内为静态占位数据，仅用于校验 2 列栅格、奇数末卡横跨全宽、温度网格等布局规则，
不代表真实设备状态。

## 与 main（OpenWrt）分支的差异

| 项 | main | Debian |
| --- | --- | --- |
| 运行环境 | OpenWrt + LuCI + rpcd/ubus/UCI | Debian + systemd |
| 前端载体 | LuCI 页面（uhttpd 托管） | 独立 WebUI（后端托管，端口 9000） |
| 前端→后端 | ubus → ucode 代理 → TCP RPC | HTTP API + WebSocket |
| 配置存储 | UCI（`/etc/config/at-webserver`） | JSON（`/etc/mt5700/config.json`） |
| 接口管理 | netifd / init.d / hotplug | on-uplink.sh 钩子（DHCP 尽力而为） |
| 系统日志 | logread (syslogd) | journalctl |
| 打包 | ipk/apk（OpenWrt SDK 交叉编译） | cargo 直接编译 + install.sh，或 deb 包 |
| 前端压缩 | LuCI 打包期可 minify（`LUCI_MINIFY_JS`） | **无构建期压缩**，源码直出 |
| 二进制分发 | Release 挂 ipk/apk 资产 | Release 挂 `at-webserver_*_amd64/arm64.deb`，标签前缀 `debian-v*` |
| CI | `.github/workflows/build-openwrt.yml`（3 架构矩阵） | `.github/workflows/build-deb.yml`（amd64 + arm64 矩阵） |

> **标签空间隔离**：本分支的 Release 标签统一使用 `debian-v*` 前缀（如 `debian-v2.0.0`），
> 与 `main` 分支的 `v*`（OpenWrt 包）互不干扰。分支推送时 CI 自动以 `debian-v<Cargo版本>`
> 作为 Release 名；也可手动打 `debian-v*` 标签指定名称。

### 前端同步机制

`webui/luci-static/resources/**` 与 `main` 分支的 `htdocs/luci-static/resources/**`
**保持同源同步**：`main` 的纯前端 UI 改动可直接同步到本分支对应路径，改动随下次
`install.sh` 部署即生效，无需打包或构建。

以下文件为 Debian 独立实现，**同步时必须保留本分支版本，不得用 `main` 覆盖**：

| 文件 | 独立实现的原因 |
| --- | --- |
| `at-webserver/rpc.js` | `main` 走 LuCI RPC（`L.rpc.declare` + rpcd/ucode 代理）；本分支映射到后端 HTTP API（`/api/*`），含鉴权头注入、401 → `REQUIRE_AUTH_KEY` 流程 |
| `view/at-webserver/service.js` | `main` 经 init.d 管理服务；本分支经 systemd，管理 `/api/service/status|restart` 与 `/dev` 串口扫描，保存流程改为 `/api/config` + `/api/config/apply` 热应用 |

`main` 侧的 `Makefile`、`scripts/sdk-build.sh`、`.github/workflows/` 属 OpenWrt 构建
体系，本分支无对应物，不做移植。

## 更新日志

本分支的变更记录见 [`CHANGELOG.md`](CHANGELOG.md)，逐版本的设计说明与实测记录见
[`docs/release-notes/`](docs/release-notes/)。

版本号与 `main` 分支**完全独立**（本分支后端版本即 deb 包版本，当前 `2.0.0`，
Release 标签前缀 `debian-v*`），不对应 `main` 的 v1.x 编号；`main` 侧的变更记录见
`main` 分支的 `CHANGELOG.md`。

## 许可

GPL-3.0，与上游一致。
