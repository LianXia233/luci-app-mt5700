# 全仓代码系统性审查报告（前端 + 后端）

- **仓库**：`woshinibabao1/MT5700-Console`（本地 `D:\AI空间\MT5700`）
- **第一轮**：2026-09-17，基线 `main @ 12506c1`（版本 2.0.7），已修复 5 项（F1–F5）
- **第二轮（增量）**：2026-09-18，基线 `main @ 26f6507`（版本 2.1.4），已修复 7 项（R1–R7）、新增 4 条待决项（H23–H26）
- **行号**：未注明轮次的条目以第一轮基线为准；R/H23+ 条目见各自小节标注的位置
- **★ 时效提示**：本文是**快照式审查报告**，行号与结论只对上述两个基线负责。
  其中涉及**连接看门狗**（`watchdog.sh` / `init.d/mt5700-watchdog` / UCI `watch_*`）
  的条目已于 **2026-09-20 随功能整体删除而失效**，不要再照着去改——
  删除的完整性由 `tests/watchdog-removed-contract.test.js` 钉住。
- **审查范围**：**全部代码**，共 71 个文件 / 30,109 行
  - 前端 JS 16,178 行（11 个视图 + 6 个共享模块 + 1 个 CSS）
  - Rust 后端 5,739 行（`src/rust/src/*.rs` 14 个文件）
  - Shell / 系统集成 987 行（watchdog、init.d、hotplug、rpcd ucode、ACL）
  - 测试 3,968 行（21 个测试文件）+ 构建脚本与 CI
- **方法**（agent-council 四角色会审）：
  1. **四路并行分诊**：视图层 / 共享模块+CSS / Rust 后端+系统集成 / 测试+构建工程，
     各自只读取证并写入独立草稿（`.workbuddy/tmp/council/scan-*.md`），共 55 条；
  2. **Proposer 汇总去重** → 36 条并定级；
  3. **Reviewer 逐条复核 P0、查误报、查红线冲突**（推翻 1 条定级、校正 2 处证据、补 5 条漏项）；
  4. **主控亲自复核**：每条拟修改项都打开源码核对行号与前提，并实跑验证，子代理结论不直接采信。
- **红线（全程遵守）**：未向真机下发任何 AT 指令、未连接 `192.168.10.1`、未占用 `/dev/ttyUSB1`、
  未触碰 PIN；所有测试均为静态断言或本地沙箱执行。

> **行号说明**：报告中的行号以基线 `12506c1` 为准。本轮已修改的文件行号会偏移，
> 已修项在「第零节」标注了对应提交，请以提交内容为准。

---

## 零、本轮已修复并验证（5 项，均已提交）

| # | 等级 | 问题 | 位置（基线行号） | 提交 |
|---|---|---|---|---|
| F1 | **高** | watchdog 的 `nc -w 5` 让**所有 AT 复位指令从未真正下发** | `root/usr/share/mt5700/watchdog.sh:290,292` | `3a49f99` |
| F2 | 中 | `isErrorText` 把应答正文里的 "error" 判成命令失败 | `htdocs/.../at-webserver/rpc.js:264-268` | `8508417` |
| F3 | 中 | `+CLCK` 正则失配 → **PIN 锁只能启用、永远关不掉** | `htdocs/.../view/at-webserver/modem_settings.js:340` | `8534173` |
| F4 | 中 | 升级页密钥错误只报错不弹框 → **升级页永久锁死**；FOTA 进度查询缺 catch | `htdocs/.../view/at-webserver/upgrade.js:569-577`、`447-462` | `78479af` |
| F5 | 中 | `ok(..., true)` **字面量恒真**的假断言（看着有覆盖其实零覆盖） | `tests/dial-contract.test.js:159` | `07223e0` |

### 第二轮（2026-09-18，基线 `26f6507`，版本 2.1.4 → 2.2.0）已修复并验证（7 项）

| # | 等级 | 问题 | 位置 | 提交 |
|---|---|---|---|---|
| R1 | **高** | **短信存储位置「配置无法保存」**：界面给了本机不支持的 `MT` 选项，且下拉框从不回写模组当前值，保存成功也看着像没保存 | `view/at-webserver/sms_settings.js:112-126`、`335-351` | `d6ef8ed` |
| R2 | **高** | eSIM 下载第一步就死：`pickTagValue` 遇到构造 tag（`BF2E`）整段跳过，取不到里面的挑战值 → 抛 `EUICC_TLV_TRUNCATED` | `at-webserver/euicc.js` `pickTagValue` | `5eea613` |
| R3 | 中 | eSIM 下载里**嵌套** `withIsdrSession` → 再开一条逻辑通道（ISD-R 已被外层选中，卡上通常只有 1~3 条通道） | `euicc.js` `downloadProfile` 步骤 ⑨ | `5eea613` |
| R4 | 中 | `hexToBase64('')` 抛 `EUICC_BAD_HEX`：空串代表零字节，不该判非法 | `euicc.js` | `5eea613` |
| R5 | 中 | 「处理待发回执」按钮**必然失败**：它拿不到 host，而目标地址其实写在通知里（`BF2F` 的 `0C`） | `euicc.js` / `view/.../esim.js` | `5eea613` |
| R6 | **中（安全）** | ES9+ 转发的临时文件名**可预测**（`/tmp/mt5700-es9p-<tag>-<秒>.tmp`），`/tmp` 是 1777 → 本地用户可预先放符号链接，让 `fs.open`/`curl -o` 以 root 覆盖任意文件。改用 `mktemp`（`O_EXCL` + 0600） | `root/usr/share/rpcd/ucode/mt5700.uc` | 本轮 |
| R7 | 低 | 连接状态三张表重复展示同一地址（实测 CID 1 与 `AT^DHCP` 都是 `10.0.0.5`），CID / 来源两列无信息量 | `view/at-webserver/network_status.js` | `9f946f2` |

**R1 的真机取证**（这是本轮唯一上机实测的项，Hiveton H5000M / MT5700M，经 8765 RPC）：

```
AT+CPMS?              → +CPMS: "ME",4,300,"ME",4,300,"ME",4,300
AT+CPMS=?             → +CPMS: ("SM","ME"),("SM","ME"),("SM","ME")     ← 根本没有 MT
AT+CPMS="SM","SM","SM"→ +CPMS: 10,50,10,50,10,50  OK                    ← 界面选项可写
AT+CPMS="MT","MT","MT"→ ERROR（success=false）                          ← 复现用户现象
AT+CPMS="ME","ME","ME"→ +CPMS: 4,300,...  OK                            ← 已恢复原值
```

**新增守卫测试**（共 +155 项断言，全部通过）：

| 测试文件 | 项数 | 钉住什么 |
|---|---|---|
| `tests/euicc-download-contract.test.js`（新） | 76 | SHA-256 标准向量、base64 往返、域名白名单（SSRF 面）、激活码正反例、TLV 长/短格式、分块可原样拼回、ES9+ 五个端点、下载全流程（成功 + 4 类失败路径）、回执按通知自带地址发、**全程只开一次逻辑通道** |
| `tests/connection-quality-contract.test.js`（新） | 79 | 三表合并后的解析 / 地址去重 / 均速与波动 / 丢包增量 / 页面接线 |
| `tests/euicc-contract.test.js`（扩充） | 63 | 错误码集合双向全等（含新增 `EUICC_NO_ES9P` / `EUICC_ES9P_FAILED`） |

**验证**：`node tests/run-all.js` → 全部测试文件通过（30 个文件 + 语法检查，19 个 JS 零语法错误）；
`ucode -c` 在真机上校验 `mt5700.uc` → `SYNTAX_OK`。

**新增/扩充的守卫测试**（共 +38 项断言，全部通过）：

| 测试文件 | 项数 | 钉住什么 |
|---|---|---|
| `tests/watchdog-nc-contract.test.js`（新） | 6 | watchdog 的 `nc` 不得带 `-w`、必须被 `timeout` 包裹、无 nc 时 return 1 |
| `tests/at-error-text-contract.test.js`（新） | 16 | 真实载入 `isErrorText` 跑 12 条样本：正文含 error 不误判、6 类真错误必识别 |
| `tests/clck-parse-contract.test.js`（新） | 12 | 从源码**取出真实正则**跑 6 条样本 + 静态约束 |
| `tests/upgrade-poll.test.js`（扩充） | +4 | 密钥必须弹框、`AT^FOTADLQ` 必须有 catch |
| `tests/dial-contract.test.js`（改造） | +1 真实 | 恒真断言换成「CGACT 报 0 → active === false」 |

**验证方式**：`node tests/run-all.js` → **全部测试文件通过**（21 个文件 + 语法检查）；
`tests/syntax-check.js` → 17 个 JS 文件语法错误 0 个。
F5 额外做了**变异测试**：把新断言的 `=== false` 改成 `=== null` 后退出码为 1，
证明它真的在起作用，不是又一条恒真。

---

## 一、结论摘要

| 类别 | 数量 | 处置 |
|---|---|---|
| 已修复并验证（第一轮 F1–F5） | 5 | 见第零节 |
| 已修复并验证（第二轮 R1–R7） | 7 | 见第零节 |
| **需人工决策 / 高风险（未改动）** | **26** | 见第二节 H1–H26 |
| 确认误报（不改） | 1 | 见第三节 |
| 定级被下调 | 1 | 见第四节 |

**总体评价**：

- **XSS 面是干净的** —— 全仓库 `innerHTML` 仅用于 `= ''` 清空，渲染一律走 `E()` / `textContent`；
  无 `outerHTML` / `insertAdjacentHTML` / `document.write`；生产代码无 `eval` / `new Function`。
- **最贵的一类风险不是 XSS，是「独占资源的并发与破坏性命令」**：串口由 Rust 服务独占，
  任何一次「幽灵命令 / 重复下发 / 射频关了没恢复」的代价都是用户断网，且日志里查不到报错。
  （H1、H6、H14 都属这一类。）
- **唯一一条真实的安全提权链**是 H2（rpcd ACL）—— 但要说清楚：本应用**本来**就通过
  `write.ubus.mt5700: ["at"]` 授权调用方执行任意 AT（含 `AT+CFUN=` / `AT^RESET`），
  H2 描述的是「**从 AT 权限再往上到 root shell / 对外监听**」，不是从无到有的提权。

---

## 二、需人工决策 / 高风险项（未改动代码）

### H1 · 关闭「短信功能」会下发 `AT+CFUN=0` + `AT+CMGD=1,4`，且无自恢复 —— 一次误点即断网并清空全部短信

- **分类**：缺陷（破坏性命令） · **等级**：**严重**
- **位置**：`htdocs/.../view/at-webserver/sms_settings.js:253-266`（`CFUN=0` 在 264、`CMGD=1,4` 在 265；链尾 282-283 直接提示成功）
- **触发条件**：开关初值由 `loadIMS()`（303-310）按 `AT^IMSSWITCH?` 回填 —— IMS 开着就显示「短信开」，
  用户随手一拨即走这条破坏链。
- **影响范围**：`AT+CFUN=0` 关射频（**断网**）；`AT+CMGD=1,4` 删全部短信（**不可恢复**）。链尾没有 `AT+CFUN=1`。
- **建议方案**（三选一，**需你拍产品语义**）：
  - **A**：链尾补 `['AT+CFUN=1', 2000, '恢复射频']`，并把 `CMGD` 摘到已有二次确认的「清空全部短信」按钮。
    副作用：新增一条 `AT+CFUN=1` 下发（行为变更）；「关短信顺带清短信」这个既有语义消失。
  - **B**：只摘 `CMGD`，保留 `CFUN=0` —— **不推荐**，断网这个主伤害还在。
  - **C（会审推荐）**：把 `AT+CFUN=0` 与 `AT+CMGD=1,4` **一起从关闭链摘掉**，只留 `AT+CEUS=0` + `AT^IMSSWITCH=0,0,0`。
    关短信**没有必须关自身射频的物理需求**（不像飞行模式），删掉 CFUN=0 比事后补 CFUN=1 更彻底，
    也没有「先断后恢复」的窗口，且不新增任何 AT。
- **验证方法**：真机上先记录 IMS 状态 → 关闭开关 → 确认（a）仍能上网（b）短信仍在（c）`AT^IMSSWITCH?` 已变 0。
  静态侧：新增契约测试断言关闭链数组里不得出现 `CFUN=0` / `CMGD=1,4`。
- **手册参考**：3GPP TS 27.007 §7.9（`+CFUN`）、§3.5.4（`+CMGD` del=4 含义）；
  《MT5700M-CN AT 命令手册》第 12 章（本地知识库 `~/.workbuddy/skills/mt5700-at-commands`）。
- **说明**：**不加确认弹窗**这条你已裁定，本报告不再讨论。

### H2 · rpcd ACL 授权面过宽：可从 AT 权限升级到 root shell / 对外监听

- **分类**：安全 · **等级**：**严重**
- **位置**：`root/usr/share/rpcd/acl.d/luci-app-mt5700.json`
  - `5-8`：read.uci 含 `at-webserver` → 可读到 `root/etc/config/at-webserver:24` 的 `websocket_auth_key`
    （`44-47` 的 read.file 也可直接读该文件）
  - `125`：write.file 给 `/etc/init.d/at-webserver` 的 `exec`
  - `119-123`：write.file 给 `/etc/config/firewall`（配合 `95-101` 的 `service set/restart`、`102-111` 的 `uci commit/apply`）
  - 配合 `root/usr/share/mt5700/watchdog.sh:342-350,381`（`run_sh_cmd` → `/bin/sh -c "$1"`，命令取自 UCI `watch_reset_cmds`）
- **触发条件**：任何持有该 ACL 的 LuCI 会话被劫持，或任何能写 UCI `at-webserver` 包的调用方。
- **影响范围**：读走 8765 访问密钥；经 `watch_reset_cmds` 以 root 执行任意命令；
  **且存在第二条更稳的链**：写一条 firewall rule 把 8765 暴露到 WAN → `ubus call service restart firewall`
  （这条绕开了「新版 rpcd 是否还支持 `file.exec`」的版本不确定性）。
- **建议方案**（需决策粒度）：① `exec` 是否直接删（**先查「重启服务」按钮的调用点是否依赖它**）；
  ② firewall 写权限是否一并收掉；③ `websocket_auth_key` 是留在 UCI（接受本 ACL 可读）还是移到 0600 文件。
- **验证方法**：**必须真机/容器实测**——起一个受限会话，实测 `ubus call file exec` 与
  `ubus call uci set ...firewall` 是否被拒。仅 `grep -c '"exec"' acl.json` 是**伪劣验证**：
  改完必然为 0，只证明你删了那行，不证明威胁消失（firewall 那条还在）。
- **手册参考**：OpenWrt rpcd ACL 文档（ubus/uci/file 三段权限模型）；`ubus` 官方 wiki。

### H3 · 改「拨号方式」会悄悄把 `settings.enable` 写成 1，与「请先关闭自动拨号」的提示自相矛盾

- **分类**：缺陷 · **等级**：高
- **位置**：`htdocs/.../view/at-webserver/dial.js:472-481`（473 拦截、475 下发、477 夹带）
- **影响**：用户只是想改拨号方式，结果自动拨号被打开。
- **建议方案**：`AT^SETAUTODIAL=` 第一个参数用 `(settings.enable != null ? settings.enable : 0)`；
  成功回调只更新 `settings.dialMode`，不碰 `enable`。
- **⚠ 前置条件**：**必须先核对模组手册，确认 `AT^SETAUTODIAL` 第 1 个参数允许为 0**。
  在确认前不要改 —— 否则可能把「悄悄开自动拨号」变成「完全改不动」。
- **手册参考**：《MT5700M-CN AT 命令手册》16.18（`^SETAUTODIAL`），举例即 `AT^SETAUTODIAL=1,0`（第 1 位为 enable）。
  **手册语法里写作 `^SETAUTODAIL:`（少一个 I），举例却是 `SETAUTODIAL:`** —— 以举例为准（本仓 `dial.js` 已兼容两种拼写，有测试钉住）。

### H4 · `panic = "abort"` 配名为 `safe_*` 却无 `catch_unwind` 的空壳包装

- **分类**：缺陷/架构 · **等级**：高
- **位置**：`src/rust/Cargo.toml:22`；`src/rust/src/schedule.rs:176-178`；`src/rust/src/urc.rs:100-102`
- **触发条件**：任何 panic（unwrap / 越界 / 锁中毒）→ `abort()` → 守护进程直接死；procd respawn 攒满阈值后**永久放弃拉起**。
- **建议方案**：**不能只改 Cargo.toml 一行** —— 改成 `unwind` 只是不再调 `abort()`，但 `safe_tick` 里没有
  `catch_unwind`，panic 会沿 tokio task 往上冒，主流程仍在 join 上等，进程多半还是会退出。
  要做得三件一起：真正的 `catch_unwind` 包层 + 失败后的重启/退避策略 + procd `respawn` 阈值放宽。
- **需要你拍的是**：**要不要为守护进程引入重启治理**这个架构选择，以及瘦身版 ABI 能否接受 unwind 的体积代价。
- **验证方法**：注入一个必 panic 的分支，确认进程存活且后续 tick 继续（本地 `cargo test` 可覆盖 `catch_unwind` 本身）。
- **手册参考**：Rust Reference「panic runtime / abort vs unwind」；`std::panic::catch_unwind` 文档；
  procd `respawn` 参数（OpenWrt procd 文档）。

### H5 · 8765 默认空密钥即跳过认证；`allow_insecure=1` 可一键变 0.0.0.0 无认证监听

- **分类**：安全 · **等级**：高
- **位置**：`src/rust/src/config.rs:316-341`；`src/rust/src/rpcserver.rs:318-322`；`root/etc/config/at-webserver:22-24`
- **现状（会审核实过，别夸大）**：默认绑 **127.0.0.1**（不是 0.0.0.0），且有「对外 + 无密钥 → 回退回环」兜底；
  `auth_key` 出厂为空时直接跳过校验，仅靠回环与 rpcd 会话保护；密钥在 TCP 上明文传输。
- **建议方案**：非回环监听（bind ≠ 127.0.0.1 或 `allow_wan` / `allow_insecure`）时**强制要求 auth_key 非空**，
  否则拒绝启动；`allow_insecure` 启动时打 error 级日志。
- **需你拍**：是否接受「对外监听必须先配密钥」这个启动期硬约束（会影响现有部署流程）。
- **手册参考**：RFC 6335 / 端口绑定惯例；OpenWrt UCI 配置文档。

### H6 · 三处飞行模式切换只有 1/3 有串行守卫，交错执行可能把设备留在射频关闭态

- **分类**：缺陷 · **等级**：高
- **位置**：`htdocs/.../view/at-webserver/network_settings.js:246`（有 busy 标志）、`439`、`749`（裸奔）
- **触发条件**：两处流程交错（例如一个正在等 `CFUN=0` 生效，另一个已经开始跑自己的恢复逻辑）。
- **影响**：**设备被留在 `CFUN=0`**，只能重启模组恢复 —— 本仓最贵的一类故障。
- **建议方案**：三处收敛到同一串行队列；恢复射频前判断「是否还有别的流程在等射频关闭」。
- **需你拍**：统一互斥与恢复语义（谁负责最终 `CFUN=1`）。
- **手册参考**：3GPP TS 27.007 §7.9。

### H7 · Windows/无 `sh` 环境下 `watchdog-routing.test.sh` 被静默跳过，仍打印 PASS

- **分类**：测试质量 · **等级**：高
- **位置**：`tests/watchdog-routing.test.js:189-200`（probe 失败只 log，不碰 fail 计数）→ 落到 `203-205` 打印 PASS 并 `exit(0)`
- **实测**：本机（Windows，无可用 `sh`）约 40 条行为断言**一条都不跑**，run-all 依然显示 PASS。
- **建议方案**：skip 计为 fail（或至少独立退出码 + 汇总 WARN），并在 CI 补一条必跑 `.sh` 的 Linux job。
- **需你拍**：要「CI 严格 + 本地严格」还是「CI 严格 + 本地 WARN」—— 前者会让每个 Windows 开发者的 run-all 永久变红。

### H8 · CI 只跑 `cargo check --all-targets`，4 个 `#[cfg(test)]` 模块从未被执行

- **分类**：工程 · **等级**：高
- **位置**：`.github/workflows/build-openwrt.yml:44-46`；对照 `src/rust/src/atclient.rs:827`、`pdu.rs:256`、`urc.rs:677`、`smsclean.rs:198`
- **本轮为什么没直接改**：本机**没有 cargo**，无法验证 `cargo test` 是否全绿；
  在无法验证的前提下改 CI 属于「可能把绿灯改成红灯」的负优化，故只出报告。
- **建议方案**：改为 `cargo test --all-targets`（含 check），或 check 之后追加一条 test step。
- **验证方法**：CI 日志出现 `running N tests` / `test result: ok`；本地有工具链时 `cd src/rust && cargo test --all-targets`。

### H9 · 短信全文与号码明文落 localStorage，且写入口三份重复、无 TTL

- **分类**：安全/架构 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/sms_center.js:112-122,658`；`sms_settings.js:224-230`；
  `parse.js:800-824`（`saveSentMessageToCache` **零调用点**，死代码）
- **建议方案**：技术侧（收敛写入口 / 容量降到 200 并加 TTL / 配额失败要提示）可立刻做；
  **默认策略（是否「退出即清」）是产品决策**。
- **手册参考**：MDN `Window.localStorage`（同源持久、无过期机制，不适合存敏感明文）。

### H10 · 短信列表四条刷新路径并发互覆盖

- **分类**：缺陷 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/sms_center.js:338-355,786-813,328-336`
- **影响**：新短信到达 / 发送后 / 删除后 / 分段补齐四条路径并发，后回来的覆盖先回来的 →
  「弹了提示，列表里却没有」。
- **建议方案**：`refresh()` 加 in-flight 守卫（撞车排队重跑）；`newSmsHandler` 标 dirty 后触发 refresh，不自行 merge。
- **需你拍**：未读语义（标脏期间的新短信要不要算已读）。

### H11 · `Mt5700.*` 与 `Ui.*` 两套组件库 + 两套 CSS 体系 + 两套定时器清理机制

- **分类**：架构 · **等级**：中（但影响面最大）
- **位置**：`mt5700.js` / `ui.js` 全文；`mt5700.css:1-2004` vs `2005-2692`；清理见 `mt5700.js:105,679` vs `ui.js:449-489`
- **建议方案**：确立 `Ui.*` + `.at-*` 为唯一体系，`Mt5700` 只留 gauge / lineChart / staged。
- **本轮不改**：涉及 11 个视图文件全量回归，且 `.mt5700-switch` 是全站全局组件，收益远小于风险。等独立重构窗口。

### H12 · 跨文件复制粘贴的 N 份实现，且**已经出现改漏**

- **分类**：架构 · **等级**：中
- **位置**：连接密钥样板 8 份（`dial.js:670-683`、`modem_settings.js:1039-1050`、`sms_center.js:829-841`、
  `sms_settings.js:378-389`、`network_settings.js:790-804`、`schedule.js:366-381`、`terminal.js:210-221`、
  `upgrade.js:569-577`）；开关工厂 4 份；锁频条目编辑器 2 份；信号百分比 2 套（`mt5700.js:184` vs `rpc.js:690`）；
  `sleep_ctx` 2 份（`atclient.rs:815` / `schedule.rs:711`）
- **已发生的改漏**：`upgrade.js` 那份退化成只报错不弹框（即本轮 F4）。
- **建议方案**：抽 `AtWs.connectWithAuth()` / `Mt5700.switch()` / `Mt5700.lockItemEditor()` /
  `AtWs.calculateSignalPercent()`，并加静态契约测试钉住「不得再新增第 9 份样板」。
- **注意**：要改就**一次改齐 8 处**，只改一处会破坏全局一致性。

### H13 · 禁用时段的 LTE/NR 字段跳过校验却照样落盘

- **分类**：缺陷 · **等级**：中
- **位置**：`src/rust/src/schedconfig.rs:268-274`（validate 跳过）、`293-302`（uci_entries 全量写）
- **影响**：`enabled=false` 的时段里是脏值，启用后直接进 `AT^LTEFREQLOCK`。
- **建议方案**：validate 与落盘范围对齐（要么校验全部时段，要么只落盘已启用时段）。

### H14 · 并发三件套：无 single-flight、事件轮询无锁且 seq 可回退、超时不取消底层命令

- **分类**：缺陷 · **等级**：中（叠加后可达高）
- **位置**：`rpc.js:410-452`（缓存无 in-flight 去重）、`rpc.js:156-207`（1.5s 轮询 vs 6s 超时，无锁）、
  `rpc.js:51-58`（`withTimeout` 只 reject 前端 Promise，底层命令照跑）
- **影响**：并发的同一读命令全部穿透（串行发 N 次往返）；后发先回把 `eventSeq` 回退覆盖；
  超时后重试 = **幽灵命令**（重复发短信 / 锁频重复生效）。
- **建议方案**：① 加 `_inflight[key]` 复用 Promise；② 轮询加 `_polling` 布尔锁且 `if (seq > self.eventSeq)` 才赋值；
  ③ `.finally(clearTimeout)`，重试仅对「确证为 ERROR 行」生效（依赖 F2 已修的 `isErrorText`）。
- **需你拍**：③ 改变重试语义，可能影响现有超时表现。

### H15 · 信号百分比两套口径（-120 起点 vs -110 起点）

- **分类**：缺陷 · **等级**：中
- **位置**：`mt5700.js:184-187` vs `rpc.js:690-694`；调用点 `network_settings.js:679`、`network_status.js:949`
- **影响**：同一 RSRP 两处显示 20% / 0%。
- **需你拍**：哪个口径对，保留一份。

### H16 · 频带掩码用 `parseInt(hex)` + Number 运算（≥2^53 低位被吞）；`nrArfcnToMHz` 缺 FR2 段

- **分类**：缺陷 · **等级**：中
- **位置**：`htdocs/.../at-webserver/parse.js:256-292`（掩码）、`parse.js:1079-1083`（ARFCN）
- **影响**：`7FFFFFFFFFFFFF` 只解出 B56；毫米波频段算错最高 59 GHz。
- **建议方案**：掩码改 BigInt（或按 hex 字符串从低位逐字符取 bit）；ARFCN 补
  `2016667~3279165 → 24250.08 + (n-2016667)*0.06`，以上 `+(n-3279165)*0.12`。
- **手册参考**：**3GPP TS 38.104 Table 5.4.2.1-1**（NR-ARFCN 的 FR1/FR2 分段与偏移量）；
  3GPP TS 38.101-2（FR2 频段范围）。

### H17 · 「认证密钥」输入框唯独这一处 `type:'text'` 明文显示

- **分类**：安全 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/service.js:310-311`
- **建议方案**：改 `Mt5700.input('password', ...)` 并加显示/隐藏切换，与另外 7 处对齐。

### H18 · README 版本号滞后 4 个版本（8 处仍是 2.0.3），且无守卫

- **分类**：工程 · **等级**：低（会审已将其从 P1 下调）
- **位置**：`README.md:15,95,101,234,293,333,334,339`；对照 `Makefile:21`
- **建议方案**：让 `tools/bump-version.py` 顺带同步 README，或在 `tests/version-consistency.test.js` 加一条静态断言。

### H19 · 测试工程杂物（6 小项）

- **分类**：工程 · **等级**：低—中
- **位置**：`tests/mock-modem/run-e2e.sh:14-17`（硬编码 `/home/user`）、`.gitignore:5-6`（`tests/mock-modem/uci` 符号链接产物）、
  `tests/run-all.js:43-45`（计数正则覆盖不全，7 个文件显示 `-`）、
  `tests/mock-modem/e2e-test.js:92,210`（两处 `check(..., true)` 恒真，但该文件**被 run-all 有意排除**，不污染 CI）、
  `tests/sms-concurrency-contract.test.js:211`、`tests/render-refresh-contract.test.js:124-126`（断言正则过宽/带尾逗号致漏判）、
  `tests/watchdog-routing.test.sh:64`（用 sed 按行抽函数，脆弱）、
  `scripts/sdk-build.sh:212,228-238`（「内含后端」校验在 apk 上退化为体积判定）
- **建议方案**：逐条小改；其中**统一 `tests/_harness.js` 的 `report(pass, fail)`** 是根治手段 ——
  目前各文件断言助手签名不统一（`ok(name,cond)` / `ok(cond,name)` / `ok(name)` 三种并存），
  「写错一次参数顺序就得到一个恒真断言」必然会再发生（F5 就是这么来的）。

### H20 · 后端工程杂物

- **分类**：工程 · **等级**：低—中
- **位置**：`rpcserver.rs:227-247`（无连接数上限与 idle timeout）、`main.rs:197-205,219`（RPC bind 失败仍 exit 0）、
  `main.rs:149`（启动日志硬编码 `127.0.0.1`）、`schedule.rs:443,466`（重复打同一条日志）、
  `root/etc/hotplug.d/net/99-mt5700-renew:17`（硬编码 eth2，与 UCI `watch_device` 不一致）、
  `atclient.rs:815` 与 `schedule.rs:711`（`sleep_ctx` 两份同名实现）、
  `rpcserver.rs:694-703`（扫频流式回调 `try_lock` 抢不到就**静默丢小区**）
- **建议方案**：逐条小改；扫频那条建议改无锁计数 + 丢行打点（丢小区会让邻区列表缺项，且没有任何日志）。

### H21 · UCI 并发写竞态

- **分类**：缺陷 · **等级**：中
- **位置**：`root/etc/init.d/at-webserver:25,378`（无条件 commit）；`src/rust/src/schedconfig.rs:313-328`（31 次 set 的长 staging 窗口）
- **建议方案**：改 `uci batch` 一次提交；init.d 的 start/reload 不再 commit `at-webserver`。

### H22 · `getAMBR` 用 `throw 'done'` 控流 + 成功路径清 `activeCid`；`state.operator` 取了从不渲染

- **分类**：缺陷/性能 · **等级**：低—中
- **位置**：`htdocs/.../view/at-webserver/network_status.js:773-822`（getAMBR）、`763-771,106`（operator）
- **影响**：真实异常被当「未找到」吞掉；成功反而清缓存导致下一轮必重新查；
  `AT^EONS=2` 每 30s 白打一次（结果从不渲染）。
- **建议方案**：改 `{ok:true}` 哨兵；成功分支保留 `activeCid`；运营商要么补显示（挪到 60s 档）要么连函数一起删。

---

### H23 · 固件下载只接受 `http://` 明文，且**没有校验和 / 签名校验**

- **分类**：安全（传输 + 完整性） · **等级**：**高**（取决于模组能力，需人工确认）
- **位置**：`htdocs/luci-static/resources/view/at-webserver/upgrade.js:513`（`if (url.indexOf('http://') !== 0) { 报错 }`）、`:551`（`AT^FOTAOEMDL="<url>"`）
- **触发条件**：用户在升级页填写固件地址；地址由模组自己去下载。
- **影响**：同一广播域内的攻击者可劫持下载（ARP/DNS 欺骗）替换固件镜像；链路无任何
  完整性校验，装的是不是运营商那份无从判断。路由器最终跑什么固件完全取决于这一跳。
- **为什么不直接改成 https**：需要先确认 `AT^FOTAOEMDL` 是否支持 `https://`。
  手册未查到明确说明，本机也没有可用于验证的 FOTA 地址。**建议先上机试一条 https URL**，
  若模组支持就把白名单收紧为 https only；若不支持，至少要在界面上明示「明文下载、无校验」，
  并让用户自己承担。
- **验证方法**：`AT^FOTAOEMDL="https://..."` 看返回 OK 还是 ERROR；再用 `AT^FOTASTATE?` 看是否进 11/13。

### H24 · 18 处 `.catch(function () {})` 空吞异常，其中 3 处会把失败伪装成「没变化」

- **分类**：可维护性 / 缺陷 · **等级**：**中**
- **位置**：`upgrade.js:477`（`AT^FOTADL=1` 续传失败）、`sms_settings.js:372/423`、
  `schedule.js:375/391`、`modem_settings.js:755/783/884/976/985`、`network_settings.js:280/455/764`、
  `network_status.js:1169`、`sms_center.js:309`、`rpc.js:168`、`ui.js:238`
- **影响**：多数是为了「单项失败不打断整页」，这个意图合理；但**没有任何一处留下痕迹**，
  真出问题时日志里一片空白。其中 `upgrade.js:477` 最值得警惕：续传命令失败被静默吞掉，
  界面会一直停在 31（挂起），用户只能干等。
- **建议**：统一成一个 `quietFail(label)` 小工具，至少 `console.warn` 一行；
  `upgrade.js:477` 那种有实际后果的应该把失败次数计出来，超过阈值就提示用户。

### H25 · `Parse.parseFastdorm` 已成死代码

- **分类**：可维护性 · **等级**：**低**
- **位置**：`htdocs/luci-static/resources/at-webserver/parse.js:180-198`
- **背景**：R7 把「空口健康」卡换成「连接质量」时去掉了 `^FASTDORM` 查询（它只是复述一个
  用户改不了也无需改的模组开关，每轮白搭一次串口往返）。解析器随之没有调用方了。
- **建议**：删掉 `parseFastdorm` 及其测试引用；若日后要恢复「快速休眠」展示，
  直接从 git 历史取回即可。

### H26 · `serial_linux.rs:207-208` 两处 `.expect()` 可 panic

- **分类**：缺陷（健壮性） · **等级**：**低**
- **位置**：`src/rust/src/serial_linux.rs:207`（`self.reader.take().expect("SerialTransport reader missing")`）、`:208`
- **触发条件**：`reader` / `writer` 已被取走时再次调用。属内部不变量，正常流程不会触发。
- **影响**：一旦触发就是 `panic` —— 而 `Cargo.toml` 里配的是 `panic = "abort"`，
  服务直接退出、`/dev/ttyUSB1` 释放，前端所有页面一起失去响应（靠 watchdog 拉起）。
- **建议**：改成返回 `Err(...)`，让调用方决定；顺带说明为何此处不变量成立。
- **注**：`pdu.rs` / `urc.rs` / `atclient.rs:991-1020` 里的 `unwrap`/`expect` 都在
  `#[cfg(test)]` 内，不算风险；但这也意味着 CI 只跑 `cargo check` 时它们从未真正执行（见 H8）。

---

## 三、确认误报（不改）

| 项 | 结论 |
|---|---|
| 「短信两步下发：第二步被 `st.running` 挡回」（`rpcserver.rs:448-459,489-494`） | **误报**。前端是**单步**下发：`smsEncode.js:291` 的 `DATA_SEP = '\r'` 把命令与 PDU 拼成**一条**字符串（`smsEncode.js:357,363`），`sms_center.js:604` 只调一次 `submitSms`；且 `atclient.rs:702-708` 已处理 `"> "` 提示符不 notify。不存在「第二步被挡」的场景，改它反而会破坏现有的单步 + `SMS_ACCEPTED` 轮询流程。 |

---

## 四、定级被下调的项

| 项 | 原定级 | 下调后 | 理由 |
|---|---|---|---|
| `isErrorText` 假阳性（F2） | P0 | **P1（已作为便宜修复实施）** | 内核属实，但会审**证伪了两处放大说辞**：① `AT+CMGL=4` 不满足 `isRetryableRead` 任何判据（`rpc.js:252-261`），`maxAttempts=1`，**不存在「重试 3 次」**；② 触发需处于 Text 模式（CMGF=1），而本仓在 `atclient.rs:310-313`、`smsclean.rs:127`、`sms_settings.js:336`、`sms_center.js:541,544,584` **全程强锁 PDU 模式**，PDU 下正文是十六进制、不含英文单词。所以它**不是「每次刷新都会中」**，负担不了 P0 权重 —— 但改窄是严格更优，已实施。 |

---

## 五、与上一轮报告（2026-09-16，仅前端）的对照

| 上轮编号 | 问题 | 本轮状态 |
|---|---|---|
| R1 | 关闭短信功能无确认弹窗（CFUN=0 + CMGD） | **维持你的决定不加弹窗**；缓解方案转为 H1 待你选 A/B/C |
| R2 | rpcd ACL 的 read 段可泄 `websocket_auth_key` | **仍未修**，本轮升级为 H2，并补出第二条更稳的提权链（firewall + service restart） |
| R3 | `+CLCK` 正则失配，PIN 锁只能启用无法关闭 | **本轮已修**（F3），用的是正则兼容两种应答格式 + 行锚定，**未向真机下发任何 AT** |
| M2/M3/M4 | 定时器生命周期三套方案 | 已收敛（本轮未发现新增泄漏；`api.interval` 的 scopeEl 机制有效） |
| M12/M13 | CSS 死规则与主题耦合 | 仍未处理，并入 H11（两套 CSS 体系）统一考虑 |

---

## 六、手册与技术依据索引

| 依据 | 用于 |
|---|---|
| 3GPP TS 27.007 §7.9 / §3.5.4 | `+CFUN` / `+CMGD` / `+CLCK` / `+CME ERROR` 语义（H1、H6、F3） |
| 3GPP TS 23.040 | 短信 PDU 编解码（F2 相关路径；`pdu.rs` / `smsEncode.js`） |
| 3GPP TS 38.104 Table 5.4.2.1-1 | NR-ARFCN 的 FR1/FR2 分段（H16） |
| 《MT5700M-CN AT 命令手册》16.18 | `AT^SETAUTODIAL` 参数与拼写差异（H3） |
| BusyBox `nc` 用法（v1.38 精简版无 `-w`） | F1（并在 CHANGELOG:1276、`mt5700.uc:324` 有本机实测记录） |
| MDN `String.prototype.match` / `Promise` / `localStorage` | F2、F3、F4、H9 |
| Rust Reference（panic runtime）+ `std::panic::catch_unwind` | H4 |
| OpenWrt rpcd ACL / procd respawn / UCI 文档 | H2、H4、H21 |

---

## 七、未验证声明（诚实边界）

本报告的**已修项**全部经过本机实跑验证（21 个测试文件全绿 + 语法检查 0 错误 + F5 变异测试）。
但以下**没有**验证，请勿据本报告认为它们已安全：

1. **第一轮没有一项经过真机验证** —— 红线禁止当轮连设备/发 AT。H1、H6、H13、H20 涉及真实下发行为，
   上线前必须在真机上按各自「验证方法」跑一遍。
   第二轮**只有 R1 上了真机**（`AT+CPMS` 系列，只读查询 + 可回滚的写入，见第零节取证），
   其余仍为静态分析 + 本地测试。
2. **Rust 侧没有本地编译验证** —— 本机无 cargo，H4、H8、H13、H20、H21、H26 均为静态分析结论。
3. **H2 的安全结论未做实测** —— 需要在容器/真机起受限会话验证，见「验证方法」。
4. **eSIM 下载链路（第二轮新增）没有真 eUICC 可跑** —— 本机是普通 USIM
   （`SELECT ISD-R` 返回 `6A82`），因此 `downloadProfile` 的十步流程只有 mock 级验证：
   协议骨架、APDU 分块、失败路径都钉住了，但**真实 SM-DP+ 的字段名与卡侧状态字未经实测**。
   已知不确定点：① `EUICCInfo1` 是否要带 `BF20` 头一起 base64 给服务器；
   ② `PrepareDownload` 里确认码哈希的 tag 与位置；③ BPP 分片的 P2 是否需从 1 起。
   缓解：整条链路的服务器原话与 APDU 状态字都原样写进日志，一旦对不上能立刻定位，不会静默失败。
5. 会审中**子代理给出的行号约 1/5 有偏差**，Proposer 抽查 21 条校正了 6 条；
   本报告的行号虽经主控复核，仍建议以「函数名/符号名」为主、行号为辅。

---

## 八、「连接工具」候选筛选：实测排除项（2026-09-18，版本 2.3.0）

为「连接质量」整卡换血而做的两轮筛选（238 条手册命令差集 → 上机只读实测）。
**以下候选已实测排除，日后别再重复劳动**：

| 候选 | 排除依据 |
|---|---|
| `AT^CGMTU` MTU | 真机 `AT^CGMTU=1` → `1,0,0,0`，**网侧根本没配 MTU**，全 0 无意义 |
| `AT^PHYCOMCFG` | 改 PA 发射功率，属射频 → 红线（不改模组射频）排除 |
| `AT^FREQLOCK` | 真机 `0,"01"` / `0,"02"` 是 **GSM/WCDMA 锁频**，本机 5G SA 用不上；且 network_settings 已有锁频 |
| 日志导出三兄弟 `^MDON` / `^LOGCATSWITCH` | 手册明写「需配合工具」，取不回来 |
| `AT^DSFLOWRPT`（2 秒一次速率上报） | 后端 `urc.rs` 未解析，要用须改 Rust 重编译 |
| `AT^LCELLINFO` / `AT^TRANSMODE` | 本机 NR 主模，直接 ERROR |
| `AT^ADCREADEX` 的「解读」 | 手册只说管脚数量不同、**未定义每个管脚接什么**，故只给裸值不解读 |
| `AT^CGCATT`（CS/PS 附着） | 与「连接状态」卡已有信息重复 |
| `+CCLK`（模组时钟） | 无网络授时时是占位值，会显示假时间（与已删的 `^NWTIME` 同理） |

**最终落地的六项**及手册依据见 CHANGELOG 2.3.0 条目。
**2026-09-18 二次调整（2.3.1）**：「网络拒绝原因」迁到「网络设置 → 网络拒绝」、
「服务状态监听」整块下线（含 `Parse.parseSrvst` / `srvStatusText` 与 rpc.js 的 SRVST 分发）、
ADC 改为进页面自动读一次 —— 现为四项，依据见 CHANGELOG 2.3.1 条目。

**未经实测的部分**：`^REJINFO` 的上报内容**无法主动触发**（要等模组真的被拒）。
已验证的是：前端解析与事件通道已接线（parse.js `parseRejInfo` + rpc.js URC 分发 +
network_settings.js 订阅）；但**端到端的「真的推了一帧并被卡片收到」尚未在真机上观察到**。
（`^SRVST` 该问题随功能下线一并消失。）

---

## 九、性能专项会审（2026-09-18，版本 2.3.9）

> 本轮目标：前端全面优化，提升响应速度。会审走 agent-council `build` 模式
> （提案 → 构建 → 审查 → 收口）。**已落地的部分见 CHANGELOG 2.3.9**，
> 本节只列**需人工决策 / 高风险 / 本轮明确不改**的项，
> 以及两条「现在不构成问题、但将来可能触发」的结构性风险。

### R-A · 全局串行 AT 队列 + 3 次重试 + 14s 超时 = 单条命令最坏冻结整页 42.6s（结构性风险，暂不改）

- **严重等级**：中（当前实测**未触发**，属潜在风险）
- **位置**：`htdocs/luci-static/resources/at-webserver/rpc.js:453`（`this.commandQueue = this.commandQueue.then(...)`）、`rpc.js:449-451`（`maxAttempts`）、`rpc.js:82`（`commandTimeout = 14000`）
- **描述**：所有 AT 命令共用一个串行 Promise 链。读命令默认重试 3 次，每次超时 14s，另有 200/400ms 退避 —— 一条命令最坏占用 `3 × 14 + 0.6 ≈ 42.6s`，期间**整页所有 AT 读数一起停摆**（不只是这一条）。
- **实测证据（2026-09-18，走 8765 裸 TCP，与前端同一通道）**：`network_status.js` 实际下发的 **23 条只读命令**全部在 **0.20–0.40s** 内返回，其中 22 条成功、`AT^DHCPV6?` 恒定失败。**没有任何命令触发超时**，因此 42.6s 的最坏情况当前不存在。
- **为什么本轮不改**：把 `commandTimeout` 或默认 `maxAttempts` 调小会**直接削弱错误恢复能力** —— 模组在重注册、FOTA、插拔卡时确实会慢。没有实测支撑「该调到多少」，贸然调整属于负优化（降低错误恢复）。
- **建议方案**（需人工决策后再动）：
  1. 给队列加**可观测性**：记录每条命令的实际耗时与重试次数，先在真机上跑一周拿到分布，再定阈值；
  2. 区分「读」与「写」的超时预算（写命令本就 `maxAttempts=1`，可单独给更短的超时）；
  3. 若要彻底解耦，需要后端支持命令级取消 —— 现状是超时后底层命令仍在飞（H14 已记同类问题）。
- **验证方法**：在模组重注册窗口（切飞行模式后 10s 内）刷页面，观察是否出现「全部读数停住 > 15s」。
- **参考**：MDN — Promise 链串行化会把最慢一环的延迟叠加到后续所有任务；ECMAScript 对 `Promise.prototype.then` 的调度语义（`nextTick` 微任务）。

### R-B · `E(tag, attrs, text)` 静默丢弃第 4 个及之后的参数（footgun，本轮只修了踩中的那一处）

- **严重等级**：中（已有一处真实故障；helper 本身未改）
- **位置**：`htdocs/luci-static/resources/at-webserver/mt5700.js`（`E` 的实现，仅接受第 3 参作为单个子节点）
- **已发生的真实故障**：`network_status.js` 卡头曾写成
  `E('label', {}, rateChk, document.createTextNode(' 实时监测'))` —— 第 4 参被丢弃，
  结果**「实时监测」这个勾选框旁边从来没有文字**，用户看到的是一个光秃秃的 checkbox。
  本轮已改用两步建（先建 label 再 `appendChild` 文本节点）。
- **为什么不改 helper 本身**：`E()` 是全站共用的基础 helper，改成变参会扩大影响面；
  全仓扫描确认 `htdocs/**` 只有上述**一处**踩中（`tests/network-perf-contract.test.js`
  已加静态守卫，将来再写 4 参调用会直接 CI 红）。
- **建议方案**（人工决策）：
  - 方案 1（推荐，零风险）：保持 3 参，在 `E()` 上方写一行注释说明「只挂第 3 参」；
  - 方案 2：改成变参并在**开发模式**下对多余参数 `console.warn` —— 需要确认 LuCI 前端是否有
    统一的调试开关，避免在生产环境刷屏。
- **参考**：MDN — `Element.appendChild()` 一次只接受一个节点；DOM 没有「多子节点构造」语义。

### R-C · 自检进行中整卡重建，用户点「重新读取」会在 click 之后被换掉（P2，本轮不改）

- **严重等级**：低（交互小坑，非性能问题）
- **位置**：`network_status.js` `renderTools()`（`toolsBody.innerHTML = ''` 全量重建）；自检每一步结束都调一次（`.then(renderTools)`），6 步共 6~8 次
- **描述**：自检跑的过程中点 ADC 的「重新读取」，按钮节点会在 click 之后被 `innerHTML=''` 换掉，表现为「点了没反应」。
- **真实代价不是 CPU**：8 次 × 约 40 个节点，毫秒级 —— 定 P2 而非 P1 的原因。
- **建议方案**：给自检单独一个容器 `checkBox`，`renderTools()` 只装配一次外壳，
  步骤回调换成 `.then(renderCheck)`，ADC 按钮不再被换掉。
- **为什么本轮不改**：属于中等重构，会动到「连接工具」卡的渲染结构，
  而该卡刚在 2.3.5 重排版、2.3.7 改固定表格，连续改动回归面偏大。
- **验证方法**：自检跑到第 3 步时点 ADC「重新读取」，看是否触发。

### R-D · 首屏约 35 条 AT 命令几乎同时进全局队列（产品决策，本轮不改）

- **严重等级**：低
- **位置**：`network_status.js` 初始化段（`refreshAll()` 与 `readAdcPins().then(runSelfCheck)` 并发）
- **描述**：≈9（设备信息）+ 2~3（快档）+ 13（慢档）+ 5（ADC）+ 6（自检）≈ 35 条命令同时排队。
  **首屏读数分批到达的观感主要来自这里，而不是 DOM 渲染** —— 把优化预算压在 DOM 上是找错了地方。
- **为什么本轮不改**：调整顺序会改变「首屏先看到什么」，属**产品决策**而非技术缺陷。
- **建议方案**：若要改善，优先让「设备信息」与「快档读数」先落、ADC/自检排在慢档之后；
  具体取舍需要用户拍板（先看到信号，还是先看到自检结论）。

### R-E · `network_status.js` 单文件 1958 行 / 88.9KB —— 明确判「不拆」

> 数字按实测更正：原稿写「1918 行 / 85KB」，实测 **1958 行 / 88,867 字节**（会审复核）。

- **严重等级**：信息（否决了「拆分」这个常见建议）
- **位置**：`htdocs/luci-static/resources/view/at-webserver/network_status.js`
- **结论**：**拆文件在 LuCI 的模块加载模型下是负优化。**
- **依据**：LuCI 的 `'require at-webserver/…'`（文件顶部）是**构建期静态声明**，
  `L.require` 按模块逐个发 HTTP 请求加载；拆成 N 个文件 = 首屏多 N 次往返，
  而 OpenWrt uhttpd 是否压缩未核对 —— 88.9KB 单文件远比 N 次往返便宜。
- **验证方法**：拆之前先在设备上实测「N 个模块各自一次请求」的耗时，比本地推测可靠。
  同时会牵动 `tests/syntax-check.js` 与打包路径。
- **被淘汰方案**：按卡片拆 6 个模块 —— 每页 JS 请求从 1 个变 7 个，首屏**更慢**，
  且模块间要重新发明一套共享 `state` 的传参方式。
- ⚠️ **参考条目「未核对」**：本节关于 LuCI 加载模型的结论来自代码静态分析与既有实测
  （首屏请求数），**未逐条对照 LuCI 官方文档**；若要作为长期架构决策，建议再核一次官方文档。

### R-F · 三条定时器不合并（快档 5s / 慢档 30s / 速率 1s）—— 明确判「不改」

- **严重等级**：信息（否决了「合并定时器」这个常见建议）
- **位置**：`network_status.js` `timer` / `slowTimer` / `rateTimer`
- **依据**：三者量级与语义都不同 —— 慢档 30s × 13 条 AT（串口），快档 5s × 2~3 条，
  速率 1s 走 **ubus 网卡计数器、完全不占串口**。并进 5s 档就丢了 1Hz 曲线的意义，
  合并会让「信号要秒级新鲜、运营商 30s 新鲜」一起退化。
- **本轮已做的边界修正**：`rateTimer` 原先逃出了 visibility 管控（后台标签页常驻 1 RPC/s，
  与设计意图矛盾），2.3.9 已纳入 —— 隐藏即停，恢复到前台丢弃旧基准再起。

### R-G · 事件轮询不跟随 visibility 暂停 —— 明确判「不改」

- **严重等级**：高（若改会造成事故）
- **位置**：`rpc.js` 事件轮询（约 1.5s）
- **依据**：暂停期间服务端事件队列持续累积，恢复时一次性灌入 ——
  与 **2.2.1 事故（模组里常驻上报、事件队列积压 106 帧、只能重启服务）同形**；
  且短信 / 来电推送依赖这条链。
- **结论**：这条与「速率定时器跟随 visibility 暂停」（R-F 已做）看似同类，
  实则相反 —— 前者是**本地发起的轮询**（停了就真的没有新数据，恢复时不会补），
  后者是**服务端持续推送的订阅**（停了服务端还在攒）。判断依据在此，勿混为一谈。

### R-H · 慢档任务不改并发 —— 明确判「不改」

- **严重等级**：中（若改会造成超时重连）
- **位置**：`network_status.js` 慢档任务链
- **依据**：并发会让 13 条命令同时挤 AT 通道，超出后端排队预算
  —— `QUEUE_WAIT_TIMEOUT = 8s` 的**真实定义在 Rust 后端**
  （`src/rust/src/atclient.rs:32`，`rpcserver.rs:415/505` 引用），
  `rpc.js:242` 只是前端转述它的注释行，别把它当定义处引。
  超限会触发超时与重连 —— 与本项目已确立的「串行不并发」原则直接冲突
  （2.2.1 事故与 ADC/自检串行化的同一条教训）。

### 本轮安全审查结论（精简集：注入 / 越权 / 不可逆确认）—— 0 条待改

- **注入**：全仓 `innerHTML` **全部**是 `= ''` 清空，无一处拼接；`E()` 文本走 `textContent`
  （MDN `Node.textContent`：赋值不解析 HTML）。无 DOM 注入面。
- **不可逆**：`AT^DSFLOWCLR` 保留 `Mt5700.confirm` 二次确认；它是写命令 →
  `isRetryableRead` 为 false → `maxAttempts=1`，失败不重试。迁到卡头后确认链路不变。
- **越权**：新增按钮不引入新 RPC、不新开 ACL 面。

### R-I · 本轮版本号变更会把 Rust 产物一起交给 CI 重编 —— 本机无法验证

- **严重等级**：低（流程提示，非缺陷）
- **位置**：`Makefile` / `src/rust/Cargo.toml` / `src/rust/Cargo.lock`
- **描述**：按项目红线，升版本必须走 `tools/bump-version.py`，它会连带改这三个文件。
  也就是说即便本轮**只改前端**，版本号变更也会让 Rust 产物需要 CI 重新编译一次。
- **影响**：本机**没有 cargo**，无法本地编译验证；只能靠 CI。若 CI 的 Rust 构建失败，
  表现形式会是「前端改动没问题但发不出 ipk」。
- **建议**：① 把 `Makefile` 计入会审的 file manifest（否则按红线升版本每轮都构成一次
  形式上的「越界」）；② 出包后确认一次 CI 的 Rust job 为绿再对外发布。
- **验证方法**：`git show --stat` 看本轮是否只多了版本号类改动；CI 日志看 Rust job。

### R-J · 速率曲线 tooltip 每秒闪断（光标静止时不恢复）—— 判「本轮不改，留方案」

- **严重等级**：中（体验缺陷，不丢数据）
- **位置**：`mt5700.js` `api.lineChart` 的 `tip` / `wrap`；`network_status.js` `renderChart()`
- **描述**：`renderChart()` 在 1Hz 下 `chart.innerHTML = ''` 并新建整棵子树，`tip` 与它的
  `show` 类随之销毁；`show` 只在 `mousemove` 里加，**光标静止时浏览器不补发 mousemove**，
  于是提示气泡每秒消失一次且不再出现，要等用户动一下鼠标才回来。
  本轮给 `mousemove` 加的 rect 缓存既不修复也不加重它（改前每事件重取 rect，同样闪断）。
- **建议方案**：把 `tip` 提到每秒重建的子树之外 —— `lineChart` 接受外部 tip 宿主
  （`options.tipEl`），由调用方持有一个模块级 tip 元素；这样既保住 rect 缓存的收益，
  也根治闪断。注意 tip 用绝对定位依赖 `wrap`，外提需要同步处理定位，**属中等改动**。
- **验证方法**：鼠标静止悬停在曲线上 5 秒，气泡不应消失；移动鼠标时数值应跟随。
- **参考**：MDN `Element.getBoundingClientRect`（读几何属性触发 reflow）、
  MDN `Element.innerHTML`（赋值会销毁并重建子树、监听器一并丢弃）。

### R-K · `renderSpeed()` 在「实时监测」关闭时仍全量重建子树 —— 判「可选优化，未做」

- **严重等级**：低
- **位置**：`network_status.js` `renderSpeed()` 关闭分支
- **描述**：关闭状态下每次调用都会重建 chart 子树并挂一段提示；而关闭状态下它只在
  开关切换时才有意义，其余是重复劳动。
- **建议方案**：用一次性 flag 判重，切换开关时才重建。属锦上添花，不做不算缺陷。
- **参考**：karpathy「极简优先」—— 不为小收益引入状态。
