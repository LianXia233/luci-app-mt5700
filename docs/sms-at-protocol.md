# 📡 短信链路协议与 AT 命令技术参考（MT5700M-CN）

<div align="center">

**luci-app-mt5700** 底层短信收发协议剖析、PDU 编解码实现与 AT 命令集精要  
*深度对照 3GPP TS 23.038 / 23.040 / 27.005 规范、厂商实机固件驱动与 Rust/Tokio 生产实现*

<p align="center">
  <img src="https://img.shields.io/badge/Hardware-MT5700M--CN-2563eb?style=flat-square" alt="Hardware" />
  <img src="https://img.shields.io/badge/Layer-Serial%20AT%20%7C%20PDU-16a34a?style=flat-square" alt="Layer" />
  <img src="https://img.shields.io/badge/Standard-3GPP%20TS%2023.040-0891b2?style=flat-square" alt="Standard" />
  <img src="https://img.shields.io/badge/Concurrency-Tokio%20Transaction-ea580c?style=flat-square" alt="Concurrency" />
</p>

</div>

---

> [!WARNING]
> **真实测试红线**：真机验证仅允许向官方特服号 `10000` 发送文本 `102`。本文涉及的所有其他报文样式均由编码器数学生成、经解码器回读比对验证，严禁向任何真实私人号码随意下发测试。

### 🧭 协议参考章节速览

<div align="center">

[1. 🔌 传输层通道](#1-传输层命令怎么送达模组) &nbsp;•&nbsp;
[2. ⚙️ 会话前置参数](#2-会话前置模组侧的开关与参数) &nbsp;•&nbsp;
[3. 📥 读取短信（列表）](#3-读取短信列表) &nbsp;•&nbsp;
[4. 📩 接收与主动上报](#4-接收一条短信进来了) &nbsp;•&nbsp;
[5. 📤 发送短信与 PDU](#5-发送短信)

[6. 🗑️ 槽位删除与清空](#6-删除与清空) &nbsp;•&nbsp;
[7. 📑 命令速查表](#7-命令速查表) &nbsp;•&nbsp;
[8. ⏱️ 三层超时预算](#8-超时预算三层必须对齐) &nbsp;•&nbsp;
[9. 🔍 待真机实测项](#9-待真机确认) &nbsp;•&nbsp;
[10. 🧪 串口手工复现](#10-手工复现串口上怎么一条一条打)

</div>

---

## 1. 传输层：命令怎么送达模组

短信的一切可靠交互均建立在**独占 AT 串口通道**的基础之上。

### 1.1 实机：`sendat` 外部工具

| 传输环节 | 厂商实机具体实现 |
| :--- | :--- |
| **端口探测** | 轮询遍历 `/dev/ttyUSB*` 与 `/dev/ttyACM*`，对各端口发送测试指令 `AT`（1.2s 超时），**首个返回 `OK` 的端口**判定为可用 AT 口；命令行参数 `<index>` 仅作为猜测提示 |
| **缓存持久化** | 探测结果暂存至 `/tmp/sendat.atport`；后续直接读取缓存，若遭遇空应答则触发全量重测并换口重试一次 |
| **并发互斥** | 通过 `flock /tmp/sendat.at.lock` 独占加锁，最长等待 8s，超时则**无锁强行发送**（尽力而为，存在并发踩踏风险） |
| **串口参数** | 原始 raw 19200 8N1：`iflag/oflag/lflag = 0`，`cflag = CS8\|CLOCAL\|CREAD`，清除 `PARENB`/`CSTOPB`，`VMIN=0 VTIME=0`，打开后执行 `tcflush(TCIOFLUSH)` |
| **指令封包** | 每一条文本命令末尾固定追加 `\r\n` |
| **完成判定** | 持续读取应答缓冲，直至去除尾部空白后以 `OK` 或 `ERROR` 结尾，或匹配到 `+CME ERROR` / `+CMS ERROR` 立即终止 |

厂商 WebUI 历史通道 `smsc.sh` 脚本架构：

```sh
sendat "$1" "$2" >/dev/null 2>&1   # 裸下发任意动作 AT（如 AT+CMGD=x 或 AT+CMGL=4）
sendat 1 at+cmgl=4 | pdu_decoder --list > /tmp/smsc.at
```

该模式在下发动作后无条件重读全量列表并刷写 `/tmp/smsc.at`。新版页面通过 `pdu_decoder --json` 交付结构化数据。

### 1.2 本仓库：常驻守护进程的 AT 客户端

| 传输环节 | 本项目技术实现 | 对应源码定位 |
| :--- | :--- | :--- |
| **智能分层选口** | 优先级排序：`/dev/serial/by-id/*` 优先 → USB 类 `ttyUSB`/`ttyACM`/`ttyAP` 回退 → 无 USB 时尝试片上串口；截取前 10 个候选，单口 `AT_PROBE_TIMEOUT=800ms`，首个返回 `OK` 即选中 | [serialdetect.rs:373](../src/rust/src/serialdetect.rs#L373) |
| **端口底层配置** | `open(O_RDWR\|O_NOCTTY\|O_NONBLOCK)`，`CS8\|CREAD\|CLOCAL`，无校验、单停止位 | [serial_linux.rs:153](../src/rust/src/serial_linux.rs#L153) |
| **阻塞语义安全** | 强制设置 `VMIN=1`（**禁止用 0**：Linux tty 在 `VMIN=0/VTIME=0` 下无数据时 `read` 返回 0 会被误判为 EOF 导致端口误关闭） | [serial_linux.rs:56](../src/rust/src/serial_linux.rs#L56) |
| **请求分级排队** | 单通道 FIFO 结合优先级调度，短信业务走 `AtPriority::Sms`，绝对优先于常规遥测采集 | [at_queue.rs](../src/rust/src/at_queue.rs) |
| **独占事务锁** | `open_sms_transaction(ctx, "sms.list", 10s)` 获取独占租约，期间彻底隔离其他命令 | [sms.rs:302](../src/rust/src/sms.rs#L302) |
| **前台交互续租** | 短信页面处于前台活跃时续租 90s（上限 `SMS_MAX_LEASE`），防止后台采集周期性抢占通道 | [sms.rs:38](../src/rust/src/sms.rs#L38) |
| **高精度错误码** | 进程初始化执行 `AT+CMEE=2`（启用详尽文本错误信息），杜绝裸 `ERROR` 盲区 | [atclient.rs:412](../src/rust/src/atclient.rs#L412) |

> [!NOTE]
> **架构核心差异**：`sendat` 每次调用临时反复开关串口并依赖文件锁；本仓库由常驻后台常态独占串口，靠内存事务锁与租约调度。本仓库必须实时剥离混入命令应答流的主动上报 URC（如 `+CMTI`、`+CDSI`、`^SMMEMFULL`），交由专用通道分发（详见 [urc.rs](../src/rust/src/urc.rs)）。

---

## 2. 会话前置：模组侧的开关与参数

### 2.1 初始化参数校验（开机 / 断线重连）

| 命令与参数 | 推荐配置值 | 规范依据与原因 |
| :--- | :--- | :--- |
| `AT+CMEE=2` | 详细错误码（文本） | 3GPP TS 27.005 定义 0=关 / 1=数字 / 2=文本；取 2 才能准确识别 `+CME ERROR: memory full` |
| `AT+CNMI=2,1,0,2,0` | 详细定义见 §4.1 | 模组手册 8.3.4 注明**掉电不保存**；MT 重启后自动复位为 `0,0,0,0,0`（导致漏收全部 `+CMTI`），每次连接必须重新校验配置 |
| `AT+CMGF=0` | PDU 编码模式 | 杜绝文本模式混淆；文本模式直接下发 HEX 字符串将导致收件方收到严重乱码 |

`AT+CNMI` 仅在实测返回值不为 `2,1,0,2,0` 时重设；`AT+CMGF` 仅在确认为 0 时跳过，强制执行严格校验。（详见 [atclient.rs:418-447](../src/rust/src/atclient.rs#L418)）。

### 2.2 短信能力开关（短信设置页专用序列）

开启短信功能的真实执行序列（[sms.rs:851-1005](../src/rust/src/sms.rs#L851)）：

```text
AT+CEUS?                      -- 读取当前模式；若已为 1 则完全跳过耗时的射频重启
AT+CEUS=1                     -- 需变更时下发；必须在 CFUN=0 之前完成
AT+CFUN=0                     -- 关闭射频
   （强制等待 ≥ 1.1s，CFUN_SWITCH_GAP 保护间隔）
AT+CFUN=1                     -- 恢复射频（单条执行预算 10s）
   （轮询 AT+CFUN? 与 AT+CEREG? 确认网络注册重新就绪）
AT^IMSSWITCH=1,0,0            -- 激活 LTE IMS 短信通路
AT+CSCA="<中心号码>"           -- 可选写入（手册 9.5.4 掉电保存，单次写入即可）
```

> [!CAUTION]
> 1. `CEUS` 修改必须经过**一次完整的射频开关循环**才能固化生效（手册 3.15.2）；若已为 1 则跳过以避免非必要断网。
> 2. `AT^IMSSWITCH` 必须在**射频恢复网络注册**后方可写入（手册 4.10.2）。
> 3. 关闭功能仅下发 `AT^IMSSWITCH=0,0,0`，绝不盲目关停射频或清空存储。

---

## 3. 读取短信（列表）

### 3.1 命令执行序列

**本仓库实现**（[sms.rs:296-367](../src/rust/src/sms.rs#L296)）：

```text
AT+CMGF?            2s    ┐ 确认为 0 时跳过；
AT+CMGF=0           2s    ┘ 异常或非 0 时强制重设（保障模式幂等）
AT+CMGL=4          25s    → 全量遍历当前存储区
AT+CPMS?            2s    → 紧随读取当前存储介质用量
```

`list()` 与 `capacity()` 属于同一次排他事务下的连续交互，绝不读取内存缓存，防止由于物理槽位动态变动造成删除操作返回 `CMS ERROR`。

### 3.2 `AT+CMGL=4` 核心语义

| 关注维度 | 规范与实现细节 |
| :--- | :--- |
| **状态过滤参数** | 0=REC UNREAD、1=REC READ、2=STO UNSENT、3=STO SENT、**4=ALL（全部）** |
| **应答返回形态** | 若干组 `+CMGL: <index>,<stat>,,<length>` 头行搭配紧随的 PDU HEX 数据行，以 `OK` 终结 |
| **作用域约束** | **仅读取当前 `<mem1>` 存储区**（手册 8.1.1）；因此短信缺失时首要核实存储介质 |
| **SMS-SUBMIT 混合** | 状态 4 会同步读出已发出的 **SMS-SUBMIT** 报文。其与 SMS-DELIVER 结构不同（含 TP-MR，无 SCTS），必须依 TP-MTI 独立分派解码（[pdu.rs:402](../src/rust/src/pdu.rs#L402)） |
| **硬件翻转已读** | 手册 9.8.2：`AT+CMGL` 一旦列出未读报文，模组硬件会自动且**立刻将其状态翻转为已读** |

### 3.3 空列表与通信故障的精确判定

必须严格依据**是否存在 `OK` 终结符**来判定，绝不能仅凭「有无 `+CMGL` 行」（[sms.rs:331](../src/rust/src/sms.rs#L331)）：

```rust
if !resp.ok() { return Err(AtError::from("读取未成功完成，不能视为存储区为空")); }
```

若 SIM 卡未就绪、端口竞争失败，均会返回「零条目且无 OK」。若误判为存储为空，会导致用户进行无效的重置尝试。

### 3.4 逐字段解码规范（SMS-DELIVER）

```text
SCA 长度(1 字节) + SMSC 服务中心地址(TOA + BCD 压缩)
TP-MTI / TP-UDHI 首字节 (MTI = byte & 0x03, UDHI = byte & 0x40)
TP-OA 发信方地址 (长度 + TOA 类型 + BCD 编码号码)
TP-PID 协议标识 (1 字节，跳过)
TP-DCS 数据编码方案 (1 字节，解码字符集)
TP-SCTS 业务中心时间戳 (7 字节半字节交换：YY-MM-DD hh:mm:ss ± 时区)
TP-UDL 用户数据长度 + TP-UD 报文载荷
```

- **SCTS 真实时区折算**：本仓库解析第 7 字节时区偏移并换算为本地时区展示；实机脚本直接忽略时区导致存在 8 小时固有偏差。
- **发送时刻高精度对齐**：SMS-SUBMIT 不带时间戳，系统由常驻后端在接受时刻以 `crate::nettime::now()`（NTP 优先）统一定准归档，格式 `%y/%m/%d,%H:%M:%S`。

### 3.5 TP-DCS 字符集分组判定（读侧）

DCS 字段必须**先依据 bits 7-4 进行分组**（[pdu.rs:85](../src/rust/src/pdu.rs#L85)）：

| DCS bits 7-4 | 编码组别 | 字符集提取规则 |
| :--- | :--- | :--- |
| **`0x0`–`0x3`** | 通用数据编码组 | `(dcs >> 2) & 0x03`：`00` GSM7、`01` 8bit、`10` UCS2、`11` 预留（按 GSM7 处理） |
| **`0xC`、`0xD`** | 消息等待指示组 | 取 bit2：`0` GSM7 / `1` UCS2 |
| **`0xE`** | 预留编码 | 统一按 UCS2 解析 |
| **`0xF`** | 消息类别组 | 取 bit3：`0` GSM7 / `1` 8bit；bits 1-0 为类别代码（0–3） |

> [!CAUTION]
> 严禁无脑执行 `(dcs >> 2) & 0x03`：类别 1 的 GSM7 短信（DCS `0xF5`）会被错误判定为 8bit，导致乱码。本仓库由专项单测严格锁定（[pdu.rs:1223](../src/rust/src/pdu.rs#L1223)）。

---

## 4. 接收：一条短信进来了

### 4.1 核心上报参数：`AT+CNMI=2,1,0,2,0`

| 参数项 | 取值 | 规范语义与理由 |
| :---: | :---: | :--- |
| `mode` | **2** | 接收上报直接发送至 TE（终端设备）；若处于阻塞态则暂存 ME 恢复后回补 |
| `mt` | **1** | 短信存储于模组中并上报通知 `+CMTI: "<mem>",<index>`（保持物理槽位可管理） |
| `bm` | **0** | 关闭广播消息通知 |
| `ds` | **2** | 状态报告写入模组并上报 `+CDSI: "<mem>",<index>`，识别为合法 URC 防穿透 |
| `bfr` | **0** | 模式切换时完整补发离线期间积压的通知，杜绝丢信 |

### 4.2 `+CMTI` 跨区读取陷阱与处理机制

```text
模组异步上报：+CMTI: "SM",7
```

> [!IMPORTANT]
> - `<index>` 是**该特定存储区内部**的物理序号；
> - `AT+CMGR=<index>` 默认读取的是**当前 `<mem1>` 指向的存储区**。  
> 若当前处于 `ME` 区，直接读取 `CMGR=7` 会错读模组 FLASH 里的第 7 条旧短信！

**本仓库的标准修复流**（[urc.rs:209](../src/rust/src/urc.rs#L209)）：

```text
+CMTI: "<mem>",<index>
   ↓ 判定 <mem> 是否与当前活动 mem1 相同
AT+CPMS="<mem>","<mem>","<mem>"     -- 切换至目标存储区
   ↓ 校验返回 OK 且强制等待 CPMS_SWITCH_GAP (500ms) 硬件介质就绪
AT+CMGR=<index>                     -- 读取指定物理序号的单条报文
```

### 4.3 存储满事件：`^SMMEMFULL`

模组在物理存储用尽时会发出 `^SMMEMFULL` 或 `+CMS ERROR: 322`。系统将其作为独立 URC 剥离，触发存储满通知推送并在状态中标记 `memFull: true`。在下次 `AT+CPMS?` 查询显示用量回落后自动复位，**绝不执行未经许可的静默自清理**。

---

## 5. 发送短信

### 5.1 收件人号码归一化

| 原始输入示例 | 预处理机制 | 归一化后号码 | TOA 类型 |
| :--- | :--- | :--- | :---: |
| 包含 `\s - ( )` | 过滤非法符号与分隔符 | — | — |
| `+8613800138000` | 剥除前导 `+` 号 | `8613800138000` | `91`（国际格式） |
| `008613800138000` | 剥除前导 `00` | `8613800138000` | `91` |
| `13800138000` (11 位) | 自动补齐大陆国际区号 `86` | `8613800138000` | `91` |
| `10000`、`10086` | 短号保持原样 | `10000` | **`81`（国内格式）** |
| 非纯数字或超限 | 校验拦截报错 | — | `Invalid Destination` |

### 5.2 模组下发形态（MT5700M-CN 反直觉特性）

> [!CAUTION]
> **本模组不支持 `>` 交互提示符。**  
> 唯一稳定可被模组接受的单行指令格式为：长度与 PDU 处于同一行，中间连接**字面反斜杠与字母 r（即字符串 `\r`）**：
> ```text
> AT+CMGS=20\r0031000D91683108108300F00000A70570F95B5C06
> ```
> 发送真实回车符（`0x0D`）会导致模组永久静默挂起。依赖标准两段式握手的外部工具（如 `sms_tool_q`）在本设备上完全失效。

### 5.3 发送序列与清态保障

```text
（申请短信独占事务，单片预算 40s，总限额 60s）
AT+CMGF=0                      -- 确保 PDU 模式
AT+CSCA?                       -- 读取当前短信中心地址并注入 PDU
AT+CMGS=<len>\r<PDU>           -- 单行字面量模式下发
（若任一段返回异常或超时，向串口立即写入 ESC (0x1B) 释放输入态并交还通道）
```

**ESC 清态**（[sms.rs:558](../src/rust/src/sms.rs#L558)）：若模组停留在半开输入等待态，后续的 `CPMS` 查询将被当作 PDU 字符吞掉导致串口彻底锁死。因此单片失败后必须立即写入 `0x1B`。

---

## 6. 删除与清空

### 6.1 槽位规范与降序准则

- **0 号槽位完全合法**：模组物理存储从 0 开始编址，禁止将 `slot == 0` 当作无效空值。
- **必须严格降序删除**：多槽位删除必须从最大槽位向下执行。升序删除会导致后续槽位号前移，造成误删。

### 6.2 全盘清空与介质复位

```text
AT+CPMS?                            -- 读取当前活动介质
AT+CPMS="SM","SM","SM" → 等待 0.5s → AT+CMGD=1,4
AT+CPMS="ME","ME","ME" → 等待 0.5s → AT+CMGD=1,4
AT+CPMS="<原mem1>","<原mem2>","<原mem3>"  -- 必须还原原始介质
```

---

## 7. 命令速查表

| 指令类别 | 具体 AT 指令 | 建议超时 | 典型触发场景 |
| :--- | :--- | :---: | :--- |
| **错误格式** | `AT+CMEE=2` | 2s | 串口链路初始化 |
| **通知模式** | `AT+CNMI=2,1,0,2,0` | 2s | 链路建立与重连 |
| **编码格式** | `AT+CMGF=0` | 2s | 读写前幂等校验 |
| **全量列表** | `AT+CMGL=4` | 25s | 短信中心加载与刷新 |
| **单条读取** | `AT+CMGR=<index>` | 25s | `+CMTI` 到达后提取正文 |
| **存储介质** | `AT+CPMS="<m1>","<m2>","<m3>"` | 2.5s | 跨区读取与清空 |
| **容量查询** | `AT+CPMS?` | 2s | 状态栏容量指示 |
| **中心号码** | `AT+CSCA?` / `AT+CSCA="<号码>"` | 2s | 发送准备与参数配置 |
| **单行发信** | `AT+CMGS=<len>\r<PDU>`（字面量） | 40s/片 | 短信生产提交 |
| **取消清态** | `ESC` (`0x1B`) | 2s | 发送异常即刻复位 |
| **逐槽删除** | `AT+CMGD=<slot>` | 2s | 单条与批量降序删除 |
| **全盘清空** | `AT+CMGD=1,4` | 25s | 介质批量格式化 |
| **射频重启** | `AT+CFUN=0` → 1.1s → `AT+CFUN=1` | 10s | 短信功能启闭 |
| **IMS 承载** | `AT^IMSSWITCH=1,0,0` / `=0,0,0` | 2s | 开启/关闭 IMS 短信通道 |

---

## 8. 超时预算（三层必须对齐）

| 动作类型 | 后端执行预算 | ucode 中间层 (`SMS_ACTION_TIMEOUT`) | 前端硬超时 (`SMS_ACTION_TIMEOUT_MS`) |
| :--- | :---: | :---: | :---: |
| **发信 (Send)** | 排队 10s + 60s 事务 | 70s | 72,000 ms |
| **清空 (Purge)** | 排队 10s + 逐区清理 | 70s | 72,000 ms |
| **删除 (Delete)** | 排队 10s + 30s 执行（8 槽/批） | 40s | 42,000 ms |
| **列表 (List)** | 排队 10s + 25s 遍历 | 40s | 42,000 ms |
| **开关 (Power)** | 射频开关与注册轮询 | 70s | 72,000 ms |

---

## 9. 待真机确认

1. **`CEUS` 的实际极性**：本仓库启用写入 `CEUS=1`（数据中心），厂商 WebUI 写入 `CEUS=0`。需挂载逻辑分析仪观察网络端差异。
2. **射频重启对 CEUS 的固化**：手册要求开关机生效，验证 `CFUN=0/1` 软重启是否完全等价于物理断电。
3. **TP-SRR 状态报告影响**：置 1 是否加速导致 `^SMMEMFULL`。
4. **半开输入态的 ESC 响应**：单行字面量模式超时后，`0x1B` 是否 100% 确保释放模组内部解析状态。

---

## 10. 手工复现（串口上怎么一条一条打）

工具：`/usr/bin/sendat`（实机环境自带端口自动探测与文件互斥）。测试仅限向 `10000` 发送 `102`。

```sh
# 0) 基础参数初始化与环境体检
sendat 1 'AT+CPMS?' 5
sendat 1 'AT+CMGF=0' 3
sendat 1 'AT+CNMI=2,1,0,2,0' 3
sendat 1 'AT+CSCA?' 3

# 1) 读取当前存储区列表
sendat 1 'AT+CMGL=4' 20 | pdu_decoder --json

# 2) 模拟构建 PDU 报文（不触发真实发包）
smssend --dry 10000 102
# 应答示例：{"ok":true,"number":"10000","toa":"81","segments":1,"pdu":["..."]}

# 3) 手工执行单行发信（将 PDU 挂在字面量 \r 之后）
sendat 1 'AT+CMGS=14\r00310005810100F00000A70331980C' 40
# 预期回执：+CMGS: <mr> 然后输出 OK

# 4) 准确删除 0 号槽位并复查
sendat 1 'AT+CMGD=0' 10
sendat 1 'AT+CMGL=4' 20 | pdu_decoder --list

# 5) 清空当前活动存储区
sendat 1 'AT+CMGD=0,4' 30
```

---

> 关联文档：[README](../README.md) · [CHANGELOG](../CHANGELOG.md) · [短信使用文档](sms-usage.md) · 核心实现 [`sms.rs`](../src/rust/src/sms.rs) / [`pdu.rs`](../src/rust/src/pdu.rs)
