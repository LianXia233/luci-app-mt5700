# luci-app-mt5700 `Debian` 分支

MT5700M 5G 模组管理服务的 **Debian 独立版**：将原 LuCI 应用完整迁移为可独立运行于
Debian 的 WebUI + HTTP API 服务，移除对 LuCI / ubus / rpcd / UCI / netifd 等
OpenWrt 专属组件的全部依赖。

原 OpenWrt/LuCI 版本保留在 `main` 分支，本分支不回改其任何代码。

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
  └── install.sh           一键编译安装
tests/mock-modem/          mock 模组 e2e 测试（TCP RPC 通道）
```

## 部署（Debian 11+）

### 一键安装

```bash
sudo apt install -y build-essential pkg-config curl
sudo ./debian/install.sh
```

脚本执行：编译 `src/rust` → 安装二进制与 WebUI → 写入配置与 systemd 单元 →
`systemctl enable --now at-webserver`。

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

mock 模组 e2e（TCP RPC 兼容通道）：见 `tests/mock-modem/run-e2e.sh`。

## 与 main（OpenWrt）分支的差异

| 项 | main | Debian |
| --- | --- | --- |
| 运行环境 | OpenWrt + LuCI + rpcd/ubus/UCI | Debian + systemd |
| 前端载体 | LuCI 页面（uhttpd 托管） | 独立 WebUI（后端托管，端口 9000） |
| 前端→后端 | ubus → ucode 代理 → TCP RPC | HTTP API + WebSocket |
| 配置存储 | UCI（`/etc/config/at-webserver`） | JSON（`/etc/mt5700/config.json`） |
| 接口管理 | netifd / init.d / hotplug | on-uplink.sh 钩子（DHCP 尽力而为） |
| 系统日志 | logread (syslogd) | journalctl |
| 打包 | ipk/apk（OpenWrt SDK 交叉编译） | cargo 直接编译 + install.sh |

## 许可

GPL-3.0，与上游一致。
