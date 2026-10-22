<div align="center">

# MT5700 Console

**鼎桥 MT5700M-CN 5G 模组 · OpenWrt LuCI 管理控制台**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-Releases-lightgrey)](https://github.com/woshinibabao1/MT5700-Console/releases)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-23.05%20%7C%2024.10%2B-brightgreen)](https://openwrt.org/)

信号 · 短信 · 锁频 · 拨号 · eSIM —— 常驻在路由器后台，浏览器只是它的操作台。

</div>

---

![网络状态](docs/screenshots/01-status.png)

## 它是什么

一个 LuCI 插件加一个 Rust 常驻服务，把 MT5700M-CN 的 AT 能力搬进 OpenWrt：串口独占、AT 命令队列、URC 事件分发、短信 PDU 收发、定时锁频都在后台完成，页面只负责展示与下发。

| 项 | 值 |
|:--|:--|
| 包名 | `luci-app-mt5700`（单包，已内含后端二进制） |
| 服务 / 配置 | 服务 `at-webserver` · 二进制 `/usr/bin/at-webserver-rust` · UCI `/etc/config/at-webserver` |
| 链路 | LuCI → rpcd + ucode → Rust（`127.0.0.1:8765`，仅回环）→ 模组 AT |
| 默认连接 | PCUI 串口 `/dev/ttyUSB1`（TCP 备用） |
| 适用 | OpenWrt 23.05（ipk）/ 24.10+（apk）· **只发布 `aarch64_cortex-a53`**（CPE 目标机架构；源码可自行交叉编译其它架构） |

> 后端只监听回环，页面经 rpcd 代理，依赖 LuCI 登录态与 ACL。

### 与手机工程模式对齐

原厂深层能力都保留了，不是「能看信号」就完事：多载波聚合（`^MONSC` / `^MONSSC` / `^HFREQINFO`）、邻区扫描（`^MONNC` / `^NRSSBID`）、网络拒绝原因（`^REJINFO`）、SIM 状态（`^SIMSQ`）、12 路温度（`^CHIPTEMP`）。

ARFCN 一列取各载波的 **SSB 频点**（与手机工程软件一致）；`^HFREQINFO` 只给载波中心频率，仅在测不到 SSB 时兜底并显示标注 —— 避免与手机抓到的数值对不上却看不出原因。

---

## 安装

从 [Releases](https://github.com/woshinibabao1/MT5700-Console/releases) 下载**与架构匹配**的主包（约 1.2 MB，已含后端）。装错架构是最常见的失败原因，先确认：

```sh
apk --print-arch                  # apk 设备（24.10+）
opkg print-architecture | tail -1 # opkg 设备（23.05）
```

> 下面示例里的版本号为当前 `2.3.27`，实际文件名以 Release 页面为准。

```sh
# OpenWrt 24.10+（apk）
apk add --allow-untrusted ./aarch64_cortex-a53-luci-app-mt5700-2.3.27-r1.apk

# OpenWrt 23.05（opkg）
opkg install ./aarch64_cortex-a53-luci-app-mt5700_2.3.27-r1_aarch64_cortex-a53.ipk
```

启用并自检：

```sh
uci set at-webserver.config.enabled=1
uci commit at-webserver && service at-webserver restart
ls -l /usr/bin/at-webserver-rust        # 后端应存在
```

浏览器进 LuCI → **移动网络 → MT5700M模块管理**。

> 中文语言包 `luci-i18n-mt5700-zh-cn-*` 可选（noarch，不装也能用）。回环 RPC 用到 busybox 的 `nc`，精简映像先 `which nc` 确认。

---

## 页面

**12 个**，都挂在「移动网络 → MT5700M模块管理」下：

| 页面 | 做什么 |
|:--|:--|
| 网络状态 | 信号质量、载波与聚合、连接诊断、地址与 DNS、SIM/设备标识、**断网排查**（31 项三层体检）、速率与流量 |
| 网络设置 | 5G 接入模式（SA/NSA）、锁频（频点 / 小区 / Band）、**定时锁频编排**、邻区扫描与就地锁定、网络拒绝原因 |
| 拨号设置 | 自动拨号与 APN、拨号方式与 USB 端口模式、网口模式与 DMZ、PDP 上下文管理 |
| 模组设置 | 设备信息、SIM 槽位与 PIN、飞行模式、设备控制（LED / PCIe / 网卡速率）、NR 能力、网络系统配置、VoWiFi 五道门评估 |
| 语音通话 | 拨号、接听、拒接、挂断、DTMF、通话记录。**只有信令，没有声音** —— 见 [已知限制](#已知限制) |
| eSIM 管理 | eUICC Profile 的下载 / 启用 / 禁用 / 重命名 / 删除，卡容量与待发回执 |
| 模组升级 | FOTA 远程固件升级 |
| 短信中心 | 收发短信与联系人会话，长短信按 UDH 自动合并成一条 |
| 短信设置 | IMS 短信开关、短信中心号码、存储位置与容量、本地已发缓存 |
| AT 调试终端 | 直接下发 AT 指令，常用命令速查，命令可存入浏览器本地 |
| 运行日志 | 模组拨号 / 接口与网络 / 通知记录三档，按级别过滤、可导出 |
| 服务配置 | 后端进程状态、连接方式（串口 / TCP）、RPC 端口与密钥、事件通知与 WebHook |

<details>
<summary><b>全部页面截图（12 张）</b> —— 均取自真机，IMEI / IMSI / ICCID / EID / 公网 IP / 小区标识已打码；其中 <code>04-schedule</code> 取自并入网络设置之前的独立页面</summary>

<br>

<table>
<tr>
<td align="center"><b>网络状态</b><br><img src="docs/screenshots/01-status.png" width="100%"></td>
<td align="center"><b>eSIM 管理</b><br><img src="docs/screenshots/06-esim.png" width="100%"></td>
</tr>
<tr>
<td align="center"><b>网络设置</b><br><img src="docs/screenshots/02-settings.png" width="100%"></td>
<td align="center"><b>拨号设置</b><br><img src="docs/screenshots/03-dial.png" width="100%"></td>
</tr>
<tr>
<td align="center"><b>定时锁频</b><br><img src="docs/screenshots/04-schedule.png" width="100%"></td>
<td align="center"><b>模组设置</b><br><img src="docs/screenshots/05-modem.png" width="100%"></td>
</tr>
<tr>
<td align="center"><b>模组升级</b><br><img src="docs/screenshots/07-upgrade.png" width="100%"></td>
<td align="center"><b>短信中心</b><br><img src="docs/screenshots/08-sms.png" width="100%"></td>
</tr>
<tr>
<td align="center"><b>短信设置</b><br><img src="docs/screenshots/09-sms-settings.png" width="100%"></td>
<td align="center"><b>AT 调试终端</b><br><img src="docs/screenshots/10-terminal.png" width="100%"></td>
</tr>
<tr>
<td align="center"><b>运行日志</b><br><img src="docs/screenshots/11-logs.png" width="100%"></td>
<td align="center"><b>服务配置</b><br><img src="docs/screenshots/12-service.png" width="100%"></td>
</tr>
</table>

</details>

---

## eSIM（eUICC）

全自研实现，**不依赖 lpac**：ES10a / ES10b / ES10c 命令在前端直接组装 APDU，经 `AT+CGLA`（2.3.22 新增的传输通路，自动降级 `AT+CSIM`）下发；2.3.26 起真机端到端下载已跑通。

- **读**：EID、Profile 列表（ICCID / 名称 / 状态 / 昵称）、卡剩余容量（`EUICCInfo2`）、待发通知
- **写**：下载安装、启用 / 禁用、重命名、删除；装完自动补发 SM-DP+ 安装回执
- **边界**：SGP.22 **没有导出已装 Profile 的接口**（防克隆是 eUICC 的安全根基），所以**没有备份 / 导出功能** —— 这是规范限制，不是没实现。删除 Profile 不可逆，页面会要求输入 AID 末 4 位才执行
- **坑位已处理**：删除前必须先禁用；逻辑通道上 `6A82` 会自动回退基本通道复核，不误判成「不是 eUICC」；`6999` 会翻译成「SIM 被复位（ISD-R 选择态丢失）」而不是「不支持此操作」

> ES9+ 走 GSMA 私有 PKI（根 `RSP2 Root CI1`），不在公开 CA 库里。包内已自带该根证书，无需 `-k` 跳过校验。

---

## 配置

配置在 `/etc/config/at-webserver`（单 section `config` + 扁平键）。常用的几个：

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `enabled` | `1` | 总开关 |
| `connection_type` | `SERIAL` | `SERIAL`=PCUI 串口；`NETWORK`=TCP |
| `serial_port` | `auto` | `auto` 优先探测 ttyUSB1（PCUI） |
| `autodial_enable` | `1` | 关掉则网口拿不到 IP |
| `websocket_port` | `8765` | LuCI ↔ 后端 RPC 端口 |
| `websocket_allow_wan` | `0` | 置 `1` 会对外暴露 RPC，**务必同时设 `websocket_auth_key`** |
| `wechat_webhook` | 空 | 企业微信机器人通知 |

改完 `uci commit at-webserver && service at-webserver restart`，或在「服务配置」页点「保存并应用」。完整键（通知 / 定时锁频 / 夜间日间编排）见随包默认配置文件。

> **连接看门狗已于 2.3.25 整体移除**：原先它常驻轮询、断网后自动续约 / 复位，但在「卡上没有 Profile → 永远注册不上网」这类注定失败的场景下会持续制造 `ifdown/ifup` churn。断网排查请用「网络状态 → 断网排查」（只读体检，只给事实与建议命令，不自动动手）；网口重枚举时的 DHCP 续约仍由 hotplug 脚本 `99-mt5700-renew` **事件驱动**地做一次。

### 脚本下发 AT

后端是**裸 TCP newline-JSON**，不是 HTTP —— `curl` / `wget` 一定失败：

```sh
printf '%s\n' '{"id":1,"method":"at","params":{"cmd":"AT+CSQ"}}' | nc 127.0.0.1 8765
```

报文必须带 `id`，AT 参数名是 `cmd`；是否成功只看返回里的 `result.success`。

---

## 已知限制

### 通话只有信令，没有声音

| | |
|:--|:--|
| 能用 | 拨号、接听、拒接、挂断、通话状态与时长、DTMF、通话记录；来电时页面响铃 |
| 不能用 | **通话内容听不到**（本地与对端都没有声音） |
| 原因 | MT5700M-CN 的 USB 双配置共 6 个接口，没有一个 Audio Class，10 个端点全是 Bulk、零 isochronous。手册 244 条命令没有音频数据通道，`AT^SETMODE` 九个模式全为数据口。车载 PCM 引脚（GPIO 520–524）在通话中采样 2000 次均为 0 |
| 出路 | 换一颗带 **USB Audio Class** 的模组（厂商音频基线为 RM520N-GL）。插件已随包带 11 个 ALSA 模块，检测到 UAC 接口自动装载，无需重编固件 |

模组侧「车载模式」确实是开着的（`AT+CLVL=?` 返回 `(1-12)` ⇒ `wpgPcmFlag=1`），但引脚无波形、SoC 的 `audio-controller@11210000` 是 `status=disabled`、内核零 ALSA 符号 —— 三层同时为空，换固件也解决不了。

### VoWiFi 评估通过 ≠ 能打电话

「模组设置 → VoWiFi」只判五道门；`AT^IMSSWITCH` 开关只管本机 IMS，开了仍要看门表。实测（2026-10-22）：中国移动 460/00 的 ePDG 域名 NXDOMAIN（该运营商没有 VoWiFi 网元）；中国移动香港 454/12 有 A 记录但 IKE 三次重传无响应（同方法测 AT&T 阳性对照秒回，说明方法可信）。

另外本模组 `AT+CSIM` 与 `AT+CGLA` 都不透传 `CLA=0x80`，USIM `AUTHENTICATE` 送不进去 ⇒ 主机侧无法自行完成 AKA，做不了软件 IMS 终端。

### 其他

- **eSIM 没有备份 / 导出**：SGP.22 未定义导出已装 Profile 的接口（防克隆），属规范限制，不是没实现。
- **`AT+CLIP?` 不可轮询**：实测硬阻塞串口 12–15 秒，会牵连后续 3~5 条命令。来电号码改由 `^CCALLSTATE` 事件触发时读取。

---

## 排障

**接口拿不到 IP** —— 九成是这两处：

```sh
uci show network.MT5700M | grep auto                 # 期望 auto='1'
printf '%s\n' '{"id":1,"method":"at","params":{"cmd":"AT^SETAUTODIAL?"}}' | nc 127.0.0.1 8765
```

**服务没起来** —— 状态标签会给出判定（运行中 / 已禁用 / 未安装 / 不可执行 / 未注册 / 已停止）：

```sh
ls -l /etc/init.d/at-webserver                       # 缺执行位会「未注册」：chmod 0755
ubus call service list '{"name":"at-webserver"}'
logread -e at-webserver | tail -30
```

**AT 终端集体无响应** —— 服务刚启动或模组重连时，8 条初始化命令占着通道；排队有独立的 8 秒预算，偶发时等几秒重试。两类超时文案不同：「等待空闲通道超时」= 命令没发出去，「模组无响应」= 已写入但模组没回。

**域名解析不了但 IP 能 ping 通** —— 与模组无关，是 DNS 链路。先查 `uci get dhcp.@dnsmasq[0].noresolv` 和 `server`：装过 mosdns / openclash 的设备常见「接管进程没运行、`noresolv` 却留着」，dnsmasq 会退化成拒绝一切递归查询。

---

## 开发

```sh
node tests/run-all.js          # 全部契约测试（静态断言 + mock，无需真机）
sh tools/ci-local.sh           # 按 CI 的顺序复刻 contract-check 的全部步骤
sh tools/ci-local.sh --with-cargo   # 另跑 rust-check（需要本机有 cargo）
cd src/rust && cargo test      # Rust 侧
```

> `tools/ci-local.sh` 存在的理由是 2026-09-30 的一次真实事故：本地一直只用
> `tools/run-tests-inproc.js`（沙箱禁止 spawn 抓管道），而 CI 跑 `tests/run-all.js`，
> 后者会**额外追加 `tests/syntax-check.js`** —— 这一步本地从没跑过，于是"本地全绿、
> CI 判红"能同时成立（详见 CHANGELOG 113）。该脚本把 CI 的步骤集固化成本地一条命令：
> **某一步没能真跑（缺 node/python/cargo）时报 `NORUN` 并以退出码 2 结束**，
> 不给可能有歧义的绿（0 全过 / 1 真失败 / 2 结果不可信，与 `tests/run-all.js` 同一约定）。
> 它与 workflow 的一致性由 `tests/ci-parity-contract.test.js` 双向守卫。

推 `main` 或打 `v*` 标签会触发 GitHub Actions 云编译（官方 SDK + zig 交叉编译 musl 静态链接），成功后自动发布 Release。`main` 推送用 `Makefile` 里的 `PKG_VERSION` 作版本号，四处需同步（`Makefile` / `src/rust/Cargo.toml` / `Cargo.lock` / `CHANGELOG.md`）—— 用 `python tools/bump-version.py <版本>`。

> 改 `mt5700.css` 必须同步 bump `mt5700.js` 的 `MT5700_CSS_VERSION` 与 `tests/css-cachebust-contract.test.js` 的 `CSS_FINGERPRINT`，否则用户浏览器会一直吃旧样式缓存。

---

## 许可

[MIT](LICENSE)。衍生自 [LianXia233/luci-app-mt5700](https://github.com/LianXia233/luci-app-mt5700)（MIT），保留原版权声明：

```text
Copyright (c) 2026 LianXia233
Copyright (c) 2026 MT5700 Console contributors
```

> ⚠️ **上游改证边界（2026-09-30 核对）**：上游在 `cbc9233`（2026-09-15）把许可**改为 GPLv3**
> （其 `Cargo.toml` 现为 `license = "GPL-3.0"`），而本仓分叉点 `3059f15`（2026-09-12）**早于**该改证
> —— 故本仓按分叉时的 MIT 继承，署名如上。
> 由此产生一条硬约束：**该提交之后的任何上游代码都不允许复制进本仓**（会污染 MIT 授权）。
> 借鉴上游后续改进时，只能取"思路与行为约定"，实现必须自己写，并在 CHANGELOG 里注明
> 出处与"未复制代码"。已核对的同源事实：两仓根提交同为 `fe2c5508`。

AT 行为以厂商《MT5700M-CN 5G 系列模组 AT 命令手册》为准；本项目与设备厂商无隶属关系。
真机实证过的 AT 行为（含拼写差异、空值应答）由 `tests/at-thermal-status-spelling-contract.test.js`
等契约测试钉住，改动相关代码前请先读那些测试的头部注释。
