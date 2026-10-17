# v2.2.0 沙箱实测截图（模拟模组态）

> 采集时间：2026-10-17 08:2x（GMT+8）· 环境：Debian amd64 沙箱 · 版本：at-webserver 2.2.0（`debian-v2.2.0` Release 资产实装）

## 测试方式（非页面级 mock）

真实安装 Release 产出的 `at-webserver_2.2.0-1_amd64.deb`，以 **socat 伪终端对 + Fibocom 风格 AT 协议模拟器**替代实体模组，使真实服务二进制走完整 AT 通道（探测 → 初始化 → 自动拨号对齐 → 遥测轮询）：

```
[at-webserver 2.2.0] --AT\r--> /dev/ttyMOCK(pts/0) --socat--> pts/1 --响应--> [mock_modem.py]
        |                                                                    |
        +-- usage 采样 eth0 真实 sysfs 计数器                                  +-- 30 条命令响应表 + 6s 周期 ^HCSQ URC
```

模拟数据锚点（与真实手册换算口径交叉验证一致）：

| 数据项 | 模拟值 | 来源命令 |
|---|---|---|
| RSRP / RSRQ / SINR | -63 dBm / -3 dB / 27.2 dB | `^MONSC` 工程值；`^HCSQ: "NR",77,236,31` 换算 77→-63、236→27.2 交叉一致 |
| 网络制式 / 频段 / CA | 5G / BR5G / 单载波(PCC) | `^HFREQINFO?` + C5GREG |
| IP 地址 | 10.132.63.155 | `^NDISSTATQRY?` / `+CGPADDR` |
| 连接时长 | 0时5分20秒 | `^DSFLOWQRY` hex `1F4` = 500s |
| 调制方式 | 256QAM(DL) / 64QAM(UL) | `^MCS=1` mcs=27 / `^MCS=0` mcs=20 |
| 流量清零日 | 每月 1 号 | `usage_reset_day:"1"` 默认配置 |

12 页全部渲染通过：**pageerror=0 / console.error=0**（无模组态下 `/api/netrate?device=` 空参的 83 条 404 亦随 device 就位而消失）。

## 图片清单

| 文件 | 页面 | 说明 |
|---|---|---|
| `_overview.png` | 总览 | 12 页拼图（4×3） |
| `home.png` | 首页 | 默认落地网络状态，信号/网络/流量三卡 + 趋势图 |
| `network_status.png` | 网络状态 | 信号强度 -63 dBm 极佳档、双 Y 轴趋势图、设备信息 tab |
| `service.png` | 服务配置 | 运行中 PID/版本、已运行时长（`AtWs.formatDuration` 修复实证）、串口/Web 服务配置 |
| `network_settings.png` | 网络设置 | 连接类型、串口设备、网络主机/端口 |
| `dial.png` | 拨号设置 | 自动拨号开关与模式 |
| `scan.png` | 全网扫频 | 扫频任务面板 |
| `schedule.png` | 定时锁频 | 锁频排程 |
| `modem_settings.png` | 模组设置 | 模组参数配置 |
| `sms_center.png` | 短信中心 | 短信列表与管理 |
| `sms_settings.png` | 短信设置 | 短信通知开关 |
| `terminal.png` | AT 调试终端 | 命令交互终端 |
| `logs.png` | 运行日志 | 运行日志查看 |

> 注：按用户要求跳过「模组升级」（upgrade）页截图。

## 复现要点

1. `dpkg -i at-webserver_2.2.0-1_amd64.deb`（Release 资产）
2. `socat pty,raw,echo=0,link=/dev/ttyMOCK pty,raw,echo=0,link=/tmp/modem-peer`
3. AT 模拟器挂 `/tmp/modem-peer`，注意两点协议细节：
   - 服务端命令以 **`\r` 结尾**（`AT+CMEE=2\r`），模拟器须按 `\r`/`\n`/`\r\n` 兼容分行；
   - `AT^SETAUTODIAL?` 须回 **`^SETAUTODIAL: 1,1`**（enable=1, mode=1 USB 网络接口），裸 `OK` 会导致自动拨号重试后放弃；
   - `^MONSC` NR 格式为 11 字段：`NR,<mcc>,<mnc>,<arfcn>,<flag>,<cid_hex>,<pci_hex>,<tac_hex>,<rsrp>,<rsrq>,<sinr>`。
4. config：`serial_port=/dev/ttyMOCK`、`netdev=eth0`（usage 走真实 sysfs 计数器）
