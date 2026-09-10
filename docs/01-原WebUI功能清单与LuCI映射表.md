# MT5700M WebUI → LuCI + Rust 完整迁移分析

> 项目：mt5700webui-openwrt-server-3.0.2
> 本文档是对原 WebUI 的完整功能盘点，以及到「LuCI 插件 + Rust 后端」的逐项映射。
> 迁移原则：**功能优先、兼容优先、稳定优先**，不允许删减、隐藏或弱化任何原功能。
>
> **更新（全部移植轮）**：以下此前标注"未迁移"的功能已全部移植并验证——
> ① 载波辅助小区聚合（`modem/carrier.ts` → `parse.js::parseMonsscAll/parseCascellAll/carrierSignalFor/unmatchedSecondaries`，
> 面板：`network_status.js`「辅载波信号」，含未归入孤儿小区列表）；
> ② `^REJINFO` 网络拒绝原因面板（`modem/reject.ts` → `parse.js::parseRejInfo/rejectCauseText`，
> `ws.js::parseRawData` REJINFO 类型拆分，面板：`network_settings.js`「网络拒绝」实时订阅）；
> ③ Info.tsx 全部面板补齐：`^SIMSQ` 卡状态（`modem_settings.js` SIM 卡区）、
> 发射功率/ENDC/5GC 注册/PDP 地址（`network_status.js`「连接诊断」面板）、
> `THERMLDAUTOPARA` 阈值与当前温保等级（`modem_settings.js` 温度保护区）；
> ④ 原源码无 MDM 相关内容（核对 Info.tsx 1433 行全部面板后确认）。
> 对应测试：e2e 22/22（原 17 + 新增 5 项）、前端解析层单测 19/19。

---

## 1. 原项目构成

| 子项目 | 技术栈 | 作用 |
|---|---|---|
| `at-webserver/` | Go（gorilla/websocket） | 后端服务：连接 5G 模组 AT 口（网络/串口）、WebSocket 服务、短信/来电/信号上报分发、企业微信通知、定时锁频、小区扫频 |
| `semi-tcpweb/` | React 18 + TypeScript + Semi Design | 前端 SPA：8 个页面 + 若干面板组件，通过 WebSocket 与后端通信 |
| `luci-app-at-webserver/` | LuCI JS | 已存在的基础 LuCI 集成：服务配置、通知日志、AT 调试（仅三页，功能不全） |

后端服务名 `at-webserver`，UCI 配置段 `at-webserver`，WebSocket 默认端口 `8765`。

---

## 2. 原 WebUI 页面与功能清单（共 8 个路由页面 + 4 个内嵌面板）

### 2.1 网络状态 `/network/info`（网络 → 网络状态）

| # | 功能 | AT 命令/数据源 | 交互 |
|---|---|---|---|
| 1 | 连接状态总览（PS 注册状态） | `AT+CGREG=2` / `AT+CGREG?`（解析 stat/lac/ci/act） | 自动刷新（默认 5s） |
| 2 | 运营商显示 | `AT^EONS=2`（解析 MNC → 运营商名） | 自动刷新 |
| 3 | 上下行速率（APN AMBR） | `AT+CGACT?` 找激活 cid → `AT^DSAMBR=<cid>` | 自动刷新 |
| 4 | QCI 承载等级 | `AT+CGEQOSRDP`（无参优先，带回退 `<cid>`） | 自动刷新 |
| 5 | DHCPv4 信息（IP/掩码/网关/DNS） | `AT^DHCP?`（hex → IP 转换） | 自动刷新 |
| 6 | DHCPv6 信息 | `AT^DHCPV6?` | 自动刷新 |
| 7 | IPv6 能力 | `AT^IPV6CAP?`（capValue → 文字描述） | 自动刷新 |
| 8 | 流量统计（上次/累计，时间+收发字节） | `AT^DSFLOWQRY`（hex 解析） | 自动刷新 |
| 9 | 清零流量统计 | `AT^DSFLOWCLR`（带确认弹窗） | 手动按钮 |
| 10 | 模组温度（sub3G PA / sub6G PA / MIMO PA / TCXO / AP1 / AP2 / Modem1） | `AT^CHIPTEMP?` | 自动刷新，超温变色 |
| 11 | 服务小区信息（NR/LTE：频点、PCI、TAC、小区ID、RSRP/RSRQ/SINR/RSSI、信号质量条） | `AT^MONSC` | 自动刷新 |
| 12 | 载波聚合（主载波 + 辅载波列表，各载波信号质量） | `AT^MONSSC`、`AT^CASCELLINFO?` | 自动刷新 |
| 13 | 信号强度（RSRP/RSRQ/SINR 环形仪表） | `AT^HCSQ?`（RSRP=-140+raw） | 自动刷新 |
| 14 | 上行/下行 MCS 速率 | `AT^MCS=0` / `AT^MCS=1` | 自动刷新 |
| 15 | 实时速率曲线（PDCP 数据率，Sparkline 60 点） | `AT^PDCPDATAINFO=1[,interval]` 开启、URC `^PDCPDATAINFO:` 推送（14 字段） | 开关切换 + 间隔设置弹窗（默认 500ms） |
| 16 | 数据连接开关（PDP 激活） | `AT+CGACT?` 查询、`AT+CGACT=1,<cid>` / `=0,<cid>` | 手动开关 |
| 17 | 自动刷新开关与间隔（网络信息/流量/温度分别可配） | 前端定时器 | 每项独立开关 + 间隔输入 |
| 18 | 页面刷新 | — | 手动按钮 |

### 2.2 网络设置 `/network/setting`（网络 → 网络设置）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 19 | 系统模式（自动/5G SA/5G NSA/4G/3G/2G） | `AT^SYSCFGEX?` 查询、`AT^SYSCFGEX=<mode>,<sub>,<roam>,<band>,...` 设置（后端 normalizeSyscfgex 补引号与尾参） | 下拉选择 + 应用 |
| 20 | 5G 能力选项 | `AT^C5GOPTION?` / `AT^C5GOPTION=` | 下拉 |
| 21 | 邻区信息列表 | `AT^MONNC` | 只读列表 |
| 22 | 锁频管理（LTE/NR 各自独立） | `AT^LTEFREQLOCK?` / `AT^NRFREQLOCK?` 查询；类型 0=解锁、1=频点、2=小区、3=频段 | LockEditor 编辑 + 保存 |
| 23 | 锁频编辑组件（多组 band/arfcn/scs/pci） | 前端构造 `AT^LTEFREQLOCK=…` / `AT^NRFREQLOCK=…` | 表格编辑、增删行、类型切换 |
| 24 | 小区扫频面板 | `AT^CELLSCAN=<band>`（异步）、`AT^CELLSCAN=ABORT`、`AT^CELLSCAN=STATE`；结果经 WS 推送 `cellscan` 类型（running/done/aborted/error） | 频段多选 → 启动；运行中显示实时行 + 取消按钮 |
| 25 | SSB ID 查询 | `AT^NRSSBID?` | 只读 |
| 26 | 定时锁频面板（夜间/日间模式） | `AT+SCHED?`（JSON）、`AT+SCHED=<json>`（校验后写 UCI 并热生效）；状态含 current_mode/next_switch/switch_count/applied | 开关、时段、锁频参数编辑 + 保存 |

### 2.3 拨号设置 `/network/dial`（网络 → 拨号设置）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 27 | 自动拨号设置（开关、拨号方式、协议、APN、用户名、密码、认证方式） | `AT^SETAUTODIAL?` 查询、`AT^SETAUTODIAL=<enable>,<mode>,"<proto>","<apn>","<user>","<pass>",<auth>` 设置 | 表单 + 保存 |
| 28 | PDP 上下文列表（CID、协议类型、APN、PDP 地址） | `AT+CGDCONT?`（多行解析） | 只读列表 + 分页 |
| 29 | PDP 上下文新增/编辑/删除 | `AT+CGDCONT=<cid>,"<type>","<apn>",<addr>,0,0`、`AT+CGDCONT=<cid>` 删除 | 弹窗表单（CID/协议必填，APN 可选） |
| 30 | NDIS 数据连接状态 | `AT^NDISSTATQRY?` | 只读状态卡 |
| 31 | 拨号诊断面板 | 前端组合 AT 命令（注册状态、信号、连接检查） | 展开面板手动运行 |
| 32 | IP 过滤开关 | `AT^IPFILTERSWITCH=` | 开关 |

### 2.4 模组设置 `/system/info`（服务 → 模组设置）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 33 | 模组基本信息（厂商、型号、IMEI、固件版本、SN 等） | `ATI`、`AT+CGSN`（IMEI）、`AT^HVSST` 等 | 只读信息卡 |
| 34 | 系统模式显示 | `AT^SYSCFGEX?` | 只读 |
| 35 | 锁频当前配置 | `AT^LTEFREQLOCK?` / `AT^NRFREQLOCK?` | 只读摘要 |
| 36 | SIM 卡信息（ICCID/IMSI/运营商等） | `AT^SIMSQ?`、`AT^SIMINFO` 类命令 | 只读 |
| 37 | SIM 热插拔配置 | `AT^TDSIMHP?` / `AT^TDSIMHP=` | 开关 |
| 38 | 发射功率 | `AT^NTXPOWER?` | 只读 |
| 39 | PCIe 局域网配置 | `AT^TDPCIELANCFG?` / `AT^TDPCIELANCFG=` | 表单 |
| 40 | 温控自动重启配置 | `AT^THERMAUTOFUN?` / `AT^THERMAUTOFUN=`、`AT^THERMLDAUTOSTATUS?`、`AT^THERMLDAUTOPARA?`、`AT^THERMLDLOGSW?` | 开关 + 参数 |
| 41 | 模组复位 | `AT^RESET`（确认弹窗） | 危险操作按钮 |
| 42 | SIM PIN 处理（PIN/PUK 输入弹窗） | `AT^SIMPIN?` 查询、`AT^SIMPIN=<pin>` / PUK 解锁 | 弹窗输入 |

### 2.5 模组升级 `/system/upgrade`（服务 → 模组升级）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 43 | FOTA 模式设置 | `AT^FOTAMODE=`（0/1） | 开关 |
| 44 | FOTA 升级（远程 URL 下载） | `AT^FOTADL="<url>"`、`AT^FOTADLQ` | URL 输入 + 下载按钮 + 进度查询 |
| 45 | FOTA 状态轮询 | `AT^FOTASTATE?`（解析百分比/状态） | 定时轮询 |
| 46 | OEM 下载 | `AT^FOTAOEMDL="<url>"` | URL 输入 + 下载 |
| 47 | 本地固件升级 | `AT^FWUP`（配合文件上传） | 文件选择 + 上传 + 升级 |
| 48 | 升级历史/日志显示 | 前端状态机 | 只读 |

### 2.6 短信中心-信息 `/sms/center`（服务 → 短信中心）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 49 | 短信列表（分页 20 条/页） | `AT+CMGL=4`（PDU 模式，后端 PDU 解码） | 表格 + 分页 + 刷新 |
| 50 | 未读筛选切换 | 前端按索引筛选 `AT+CMGL=0` | 开关 |
| 51 | 短信已读/未读状态显示 | PDU 解析状态位 | 徽标 |
| 52 | 发送短信（GSM7/UCS2 编码、长短信自动分段） | `AT+CMGS=<len>` + PDU + `0x1A`（Ctrl-Z 结束） | 收件人 + 内容表单；提交后等待 `>` 提示符 |
| 53 | 删除单条短信 | `AT+CMGD=<index>`（确认弹窗） | 按钮 |
| 54 | 回复短信 | 同发送（自动填入收件人） | 按钮 |
| 55 | 新短信实时推送（Toast + 列表自动插入） | WS 推送 `new_sms`（sender/content/time/isComplete） | 订阅 |
| 56 | 长短信自动拼接（UDH concat） | 后端 `parseUDHConcat` + 分段缓存 | 推送完整内容 |
| 57 | IMS 开关查询 | `AT^IMSSWITCH?` | 只读显示 |

### 2.7 短信中心-设置 `/sms/settings`（服务 → 短信设置）

| # | 功能 | AT 命令 | 交互 |
|---|---|---|---|
| 58 | 短信中心号码 | `AT+CSCA?` / `AT+CSCA="<num>"` | 表单 + 保存 |
| 59 | 短信存储设置（mem1/mem2/mem3） | `AT+CPMS?` / `AT+CPMS="<m1>","<m2>","<m3>"` | 下拉选择 |
| 60 | 短信格式（PDU/文本） | `AT+CMGF?` / `AT+CMGF=<0|1>` | 下拉 |
| 61 | 新短信上报模式 | `AT+CNMI?` / `AT+CNMI=2,1,0,2,0` | 开关 |
| 62 | IMS 业务能力开关 | `AT^IMSSWITCH?` / `AT^IMSSWITCH=<0|1>` | 开关 |
| 63 | USSD 查询面板 | `AT+CUSD=1,"<code>"`、`AT+CUSD?` 查询；网络异步回 `+CUSD:` URC | 代码输入 + 结果展示 |

### 2.8 AT 调试终端 `/at`（服务 → AT 调试终端）

| # | 功能 | 交互 |
|---|---|---|
| 64 | 任意 AT 命令发送（WebSocket 直通） | 输入框 + 发送（Enter/Ctrl+Enter） |
| 65 | 实时响应显示（命令结果 + 主动上报分开显示） | 终端窗口（深色） |
| 66 | 常用命令快捷按钮（ATI、AT^HCSQ?、AT^NWTIME?、AT+CSQ 等） | 按钮 |
| 67 | 清屏 / 自动滚动 / 连接状态指示 | 工具栏 |
| 68 | 历史记录（localStorage） | 上箭头回看 |

### 2.9 全局/横切功能

| # | 功能 | 说明 |
|---|---|---|
| 69 | WebSocket 连接管理（重连、退避、心跳） | 30s 心跳 ping/pong，断线自动重连（最多 5 次） |
| 70 | 认证握手（可选密钥） | 连接后先发 `{auth_key}`，服务端回 `{success,message}`，前端比对"认证成功"；失败 Toast |
| 71 | 密钥本地记忆 | localStorage（rememberDays 过期） |
| 72 | 通知推送订阅 | new_sms / incoming_call / pdcp_data / urc_data / raw_data |
| 73 | 命令队列串行化 | 前端 FIFO 队列 + 服务端串行读循环，保证不串号 |
| 74 | 侧边栏导航 | 4 组：网络设置 / 系统 / 短信中心 / 调试工具 |
| 75 | 响应式布局 | PC / 平板 / 手机 |

### 2.10 后端服务功能（需 Rust 重写）

| # | 功能 | 原实现（Go） |
|---|---|---|
| B1 | AT 通道：网络(TCP) / 串口(termios) / 自动探测 | transport.go / serial_linux.go / serialdetect.go |
| B2 | AT 客户端：单读循环、命令串行(100ms 间隔)、2s 超时、2048 行上限、URC 分流、`abcd` 打断 | atclient.go |
| B3 | 初始化命令：CMEE=2、CNMI=2,1,0,2,0、CMGF=0、CLIP=1 | atclient.go |
| B4 | WebSocket 服务：认证、心跳、{success,data,error} 应答、FIFO | wsserver.go |
| B5 | 伪命令：AT+CONNECT?、AT+SCHED?、AT+SCHED=、AT^CELLSCAN* | wsserver.go/schedconfig.go/cellscan.go |
| B6 | SYSCFGEX 归一化（补引号/尾参） | wsserver.go |
| B7 | URC 分发：来电/存储满/新短信/信号/PDCP | urc.go |
| B8 | SMS PDU 解码（GSM7/UCS2/8bit + UDH 长短信） | pdu.go |
| B9 | 长短信分段缓存拼接 | urc.go |
| B10 | 企业微信通知（60s 合并、重试 3 次）+ 日志文件 | notify.go |
| B11 | 定时锁频调度器（夜间/日间、飞行模式、无服务自动解锁、扫频宽限） | schedule.go |
| B12 | 锁频命令构造（LTE/NR、类型 0-3、SCS 自动推断、频段-频点校验表） | schedule.go |
| B13 | 小区扫频异步执行 + 实时推送 | cellscan.go |
| B14 | UCI 配置读写（含 bandLock 一组选项） | config.go / schedconfig.go |
| B15 | procd 服务（start/stop/restart/enable/disable、开机自启、崩溃重启） | files/etc/init.d/at-webserver |
| B16 | 日志（stdout → logd）与 `-version`/`-verbose` 参数 | logger.go / main.go |

---

## 3. 原 WebUI → LuCI 菜单映射表

原侧边栏：

```
侧边栏
├── 网络设置
│   ├── 网络状态   /network/info
│   ├── 网络设置   /network/setting
│   └── 拨号设置   /network/dial
├── 系统
│   ├── 模组设置   /system/info
│   └── 模组升级   /system/upgrade
├── 短信中心
│   ├── 信息       /sms/center
│   └── 设置       /sms/settings
└── 调试工具
    └── AT调试终端  /at
```

新 LuCI 顶部菜单（`admin/network` 与 `admin/services` 两个顶级入口，全部功能保留）：

```
LuCI 顶部菜单
├── 网络 (admin/network)
│   ├── 网络状态      ← 网络状态
│   ├── 网络设置      ← 网络设置
│   ├── 拨号设置      ← 拨号设置
│   └── 定时锁频      ← 原拨号页内嵌 SchedulePanel（独立成页，功能不丢）
└── 服务 (admin/services)
    ├── 模组设置      ← 模组设置
    ├── 模组升级      ← 模组升级
    ├── 短信中心      ← 短信中心-信息
    ├── 短信设置      ← 短信中心-设置
    ├── AT调试终端    ← AT调试终端
    ├── 通知日志      ← 原 LuCI 已有（日志查看，保留）
    └── 服务配置      ← 原 LuCI 已有（配置，保留；含连接/通知/定时锁频 UCI 配置）
```

---

## 4. API / 数据结构兼容性

### 4.1 WebSocket 协议（完全兼容）

- 地址：`ws://<router>:8765`（UCI `websocket_port`，可配）
- 认证：连接建立后，若服务端配置了 `websocket_auth_key`，客户端先发 `{"auth_key":"..."}`；服务端回 `{"success":true,"message":"认证成功"}` 或 `{"error":"...","message":"认证失败"}`，随后关闭连接
- 心跳：服务端每 30s 发 `ping` 文本帧，收到 `ping` 回 `pong`
- 命令应答（客户端发 AT 命令字符串，服务端回）：
  ```json
  {"success": true,  "data": "+CGREG: 2,1,...\r\nOK"}
  {"success": false, "error": "..."}
  ```
- 伪命令（服务端本地处理，不发给模组）：
  - `AT+CONNECT?` → `+CONNECT: 0|1\r\nOK`（0=网络,1=串口）
  - `AT+SCHED?` → `+SCHED: {…json…}\r\nOK`
  - `AT+SCHED=<json>` → `+SCHED: OK\r\nOK`
  - `AT^CELLSCAN=...` 启动 → `^CELLSCAN: STARTED\r\nOK`
  - `AT^CELLSCAN=ABORT` → `OK`
  - `AT^CELLSCAN=STATE` → `^CELLSCAN: IDLE|RUNNING,n\r\nOK`
- 推送类型：`raw_data`（主动上报原文）、`new_sms`、`incoming_call`、`pdcp_data`、`cellscan`（running/done/aborted/error）
- `AT^SYSCFGEX` 归一化：去掉 `\r\nOK`、给频段参数补引号、补齐末尾两个空参数

### 4.2 UCI 配置（完全兼容，键名不变）

`/etc/config/at-webserver`：`enabled`、`connection_type`、`network_host`、`network_port`、`network_timeout`、`serial_port`、`serial_port_custom`、`serial_baudrate`、`serial_timeout`、`websocket_port`、`websocket_allow_wan`、`websocket_auth_key`、`cellscan_timeout`、`wechat_webhook`、`log_file`、`notify_sms`、`notify_call`、`notify_memory_full`、`notify_signal`、`schedule_*` 全部键（含 `schedule_night/day_{lte,nr}_{type,bands,arfcns,scs_types,pcis}`）。

### 4.3 定时锁频 JSON DTO（完全兼容）

```json
{
  "enabled": true, "check_interval": 60, "timeout": 180,
  "unlock_lte": true, "unlock_nr": true, "toggle_airplane": true,
  "night": {"enabled": true, "start": "22:00", "end": "06:00",
            "lte": {"type":3,"bands":"","arfcns":"","scs_types":"","pcis":""},
            "nr":  {"type":3,"bands":"","arfcns":"","scs_types":"","pcis":""}},
  "day":  {"enabled": true,
            "lte": {"type":3,"bands":"","arfcns":"","scs_types":"","pcis":""},
            "nr":  {"type":3,"bands":"","arfcns":"","scs_types":"","pcis":""}},
  "status": {"current_mode":"夜间","next_switch":"06:00","switch_count":3,"applied":true}
}
```

校验规则（与 Go 一致）：interval≥10s、timeout≥30s、HH:MM 格式、锁类型 0-3、≤20 组、LTE PCI≤503、NR PCI≤1007、频段-频点落在 3GPP 范围表内。

### 4.4 通知日志（完全兼容）

- 日志文件：UCI `log_file`（默认空，可配 `/var/log/at-notifications.log`）
- 格式：`[时间] 发送者: …\n内容: …\n` + 50 个 `-` 分隔线

### 4.5 PDCP 推送字段（完全兼容，14 字段）

`id, pduSessionId, discardTimerLen, avgDelay, minDelay, maxDelay, highPriQueMaxBuffTime, lowPriQueMaxBuffTime, highPriQueBuffPktNums, lowPriQueBuffPktNums, ulPdcpRate, dlPdcpRate, ulDiscardCnt, dlDiscardCnt`（前 6 个 delay 字段 ÷10）。

---

## 5. 统计口径

| 项目 | 数量 |
|---|---|
| 原 WebUI 页面（路由） | 8 |
| 内嵌面板/组件（独立功能单元） | ScanPanel、SchedulePanel、Diagnostics、UssdPanel、LockEditor、SimPinHandler、NotificationHandler、AuthKeyModal |
| 原功能条目（上表 #1–#75） | 75 |
| 后端功能（#B1–#B16） | 16 |
| 涉及 AT 命令/伪命令 | 60+（见 §2 各表） |
| WebSocket 消息类型 | 8（command 应答、raw_data、new_sms、incoming_call、pdcp_data、cellscan、memory_full、urc_data） |
| UCI 配置键 | 50+ |
