# 更新日志 (Changelog)

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **前端与后端合并为单个包（v1.1.0 起）**：
  - 新增 `src/Makefile`：利用 luci.mk 的 `${CURDIR}/src` 机制（`Build/Compile` 调用
    `make clean compile`、`Package/install` 调用 `Build/Install/Default`），
    在编译 LuCI 包时顺带 `cargo build` 并把 `/usr/bin/at-webserver-rust` 装进同一包
  - 根 `Makefile`：`LUCI_DEPENDS` 清空（不再依赖独立后端包）、`LUCI_PKGARCH` 置空
    （包内含架构相关二进制，不能是 `all`）、新增 `PKG_PROVIDES:=at-webserver-rust` 兼容旧装
  - 删除 `src/rust/Makefile`（后端不再作为独立包构建）
  - 效果：安装只需一个包，彻底消除 `required by: luci-app-mt5700[at-webserver-rust]` 报错
- **产物校验升级为「包内必须自带后端」**：`scripts/sdk-build.sh` 与 workflow 在产出后解包
  校验 `usr/bin/at-webserver-rust` 确实存在（apk 支持 gzip/zstd，ipk 解内层 data.tar.gz），
  避免再次出现"只有前端壳子"的包被发布

### 修复

- **Rust 后端崩溃修复（P0）**：`tokio::sync::Mutex::blocking_lock()` 在异步任务内调用必然 panic
  （`Cannot block the current thread from within a runtime`），release 配置 `panic="abort"` 下进程直接崩溃：
  - `AtClient::connected()` 改原子标志（`AtomicBool`），不再取锁阻塞 —— 修复调度器每周期
    `connected()` 触发崩溃（默认 `schedule_check_interval=60`，服务启动约 60s 后必崩）
  - 扫频流式回调改 `try_lock()`（同步闭包内不能 await/阻塞）—— 修复 CELLSCAN 期间
    read_loop 任务 panic 崩溃
  - 扫频任务收尾改 `lock().await`（异步任务内可用异步锁）—— 修复扫频结束后
    `running` 状态永不复位导致全部 AT 命令被"正在扫频"挡死
  - 运行验证：修复前 75s 崩溃（exit -1073740791），修复后 75s 存活 + 扫频全流程通过
- **LuCI RPC 配置读取修复（P1）**：`mt5700.uc` 与前端 `rpc.js` 此前按不存在的
  `websocket` UCI 段读取端口/密钥，导致修改 `websocket_port` / `websocket_auth_key` 不生效；
  配置了密钥时 ucode 不带密钥被 Rust 拒绝（-32001），整个界面不可用：
  - `mt5700.uc`：改为读取 `config` 段的 `websocket_port` / `websocket_auth_key`，
    每次调用实时读取（改配置无需重启 rpcd），连接与读取均加 3s 超时（避免阻塞 rpcd worker）
  - `rpc.js::loadConfig`：同步修正 UCI 段名与键名
- **`uci show` 读取加 5s 超时**（与 Go 版一致），避免 uci 命令异常挂起卡死服务启动
- **RPC 请求行加 8KB 长度上限**（对齐 Go 版 64KB 读限的安全意图），超限断开连接
- **交叉编译映射修正**：`src/Makefile` 的 `mips`/`mips_24kc` 此前错误映射到
  `mipsel-unknown-linux-musl`（大小端相反），已改为 `mips-unknown-linux-musl`；
  `scripts/sdk-build.sh` 同步补 `mips-linux-musl` 的 zig 目标
- **非 Linux 平台可编译**：`serial_linux.rs` / `serialdetect.rs` 增加
  `#[cfg(target_os = "linux")]` 条件编译（termios/AsyncFd 仅 Linux 可用），
  其它宿主可直接 `cargo build` / `cargo test` 验证逻辑层

- **Release 缺少后端包 `at-webserver-rust`（导致 `apk add` 报依赖缺失）**：
  - 根因：SDK 的 `make defconfig` 不会自动选中后来复制到 `package/` 的包，
    未选中时 `make package/at-webserver-rust/compile` 只打印 `Nothing to be done` 并返回 0，
    CI 全程绿灯但后端包从未产出；LuCI 包仍照常声明 `Depends: at-webserver-rust`，
    于是用户安装时报 `required by: luci-app-mt5700-1.0.0-r1[at-webserver-rust]`
  - `scripts/sdk-build.sh`：编译前显式写入 `CONFIG_PACKAGE_at-webserver-rust=m`（去重后追加），
    defconfig 后校验选中状态；编译后校验 cargo 二进制确实存在；收集产物后校验后端包存在
  - `.github/workflows/build-openwrt.yml`：build job 增加「Verify required packages」闸门，
    release job 增加「Verify dist completeness」（每个包需覆盖 2 架构 × apk/ipk 共 4 个），
    缺包即失败，杜绝再次发布不可安装的 Release
  - README 新增 §8.1「安装（前端 + 后端必须成对安装）」，并标注 v1.0.0 Release 缺后端包

### 变更

- **菜单收敛为「服务 → 模组管理」，二级菜单全部置于 Plugin Top Navigation**：
  - 原 `网络 → 5G 模组`（5 页）与 `服务 → 5G 模组`（7 页）合并为
    `服务 → AT WebServer → 模组管理` 一组 12 页（网络状态/网络设置/拨号设置/全网扫频/定时锁频/
    模组设置/模组升级/短信中心/短信设置/AT 调试终端/通知日志/服务配置）
  - 页面作为模组管理下第 3 级节点，LuCI 主题将其渲染在 **Plugin Top Navigation**（页面顶部导航条），
    侧边栏只保留两级（AT WebServer → 模组管理），页面入口无丢失
- **连接默认 PCUI 优先**：
  - `connection_type` 默认值由 `NETWORK` 改为 `SERIAL`（Rust `config.rs` 与 UCI 默认配置同步）
  - AT 走串口 `/dev/ttyUSB1`（PCUI）；`auto` 探测同样优先 `ttyUSB1`；网络 TCP 20249 保留为备用
  - LuCI 服务配置页连接类型选项改为：PCUI 串口（默认）/ 自动探测（串口优先 ttyUSB1）/ 网络连接（备用）
- **通信架构改为 LuCI RPC（移除 WebSocket）**：
  - 前端 `ws.js` → `rpc.js`：`L.rpc.declare` 调用 rpcd 对象 `mt5700`（`at` 执行 AT 命令、
    `events` 拉取事件增量），实时数据由 1.5s 轮询 `events(since)` 保证；`AtWs` API 面与页面交互不变
  - 新增 rpcd ucode 插件 `root/usr/share/rpcd/ucode/mt5700.uc`：LuCI RPC ↔ Rust 后端代理
    （TCP newline-JSON，仅回环 127.0.0.1，不对外暴露端口）
  - Rust 后端 `wsserver.rs` → `rpcserver.rs`：WebSocket 传输层替换为 TCP newline-JSON-RPC，
    核心业务逻辑（伪命令 CONNECT?/SCHED?/CELLSCAN、扫频状态机、命令分发）全部保留；
    Hub 广播改为有界事件总线（500 条，单调 seq），urc/schedule/cellscan 推送语义不变
  - 认证：LuCI 登录态由 rpcd 会话/ACL 保证；UCI `websocket_auth_key` 由 ucode 代理自动附带（兼容）
  - init.d 不再生成 RPC 端口外网防火墙规则（仅回环）；`websocket_allow_wan` 键保留兼容
  - ACL 增加 `mt5700` 对象（`at`/`events`，read + write）
- 测试同步：e2e 改为 TCP newline-JSON 客户端，**20/20 通过**；解析单测 19/19；Rust 7/7（0 warning）
- 依赖裁剪：移除 `tokio-tungstenite`、`futures-util`（传输层不再需要）

## [1.0.0] - 2026-09-10

### 新增

- **完整迁移原 WebUI 到 OpenWrt LuCI 插件**（`luci-app-mt5700`）
  - 12 个 LuCI 页面全部落地：网络状态 / 网络设置 / 拨号设置 / 全网扫频 / 定时锁频 / 模组设置 / 模组升级 / 短信中心 / 短信设置 / AT 调试终端 / 通知日志 / 服务配置
  - 原侧边栏菜单重构为 LuCI 顶部菜单体系：`网络 → 5G 模组` 与 `服务 → 5G 模组` 两个顶级入口，无功能入口丢失
  - 前端基于 LuCI View/JS + 原生 WebSocket 客户端（`ws.js`），保留原交互语义：确认弹窗、加载态、成功/错误提示、自动刷新、实时订阅
- **后端 Rust 重构**（`at-webserver-rust`，位于 `src/rust/`）
  - Tokio 异步：WebSocket 服务（认证/心跳/FIFO 应答匹配）、AT 客户端（命令串行 100ms、2s 超时、URC 分流）、PDU 编解码、定时锁频调度、小区扫频、企业微信通知、UCI 配置读写
  - 静态 musl 交叉编译支持（zig 链接器），适配 OpenWrt 多架构
- **全量移植原 WebUI 深层功能**
  - 载波辅助小区聚合（`^MONSSC` 8CC + `^CASCELLINFO` 4 SCELL + `^HFREQINFO` 频点对齐合并 + 孤儿小区不丢数据）
  - `^REJINFO` 网络拒绝原因实时面板（3GPP TS 24.008 原因表 + USIM 扩展原因）
  - 连接诊断面板（ENDC / 5G 核心网注册 / 发射功率 / PDP 地址）、`^SIMSQ` 卡状态、温度保护阈值与当前温保等级
- **GitHub Actions 云编译**（`.github/workflows/build-openwrt.yml`）
  - 最新主线（snapshot）→ `.apk` 包（OpenWrt 24.10+ apk 包管理器）
  - 老版本 23.05 → `.ipk` 包（opkg 兼容）
  - 架构矩阵：x86_64 / aarch64_cortex-a53 / mips_24kc(mt7621)；打 `v*` 标签自动发布 GitHub Release

### 修复

- Rust 后端：空闲期模组主动上报（来电/短信/信号）被全部丢弃，与 Go 原版语义不一致 → 按 `handleLine` 语义修复
- Rust 后端：Hub 广播在异步任务内调用 `tokio RwLock::blocking_read` 触发 panic 崩溃 → 改为 `std::sync::RwLock` + 非阻塞 `try_send`
- LuCI 页面缺少 `'require'` 依赖声明（运行时白屏）→ 全部补全
- `upgrade.js` 引用不存在的 `Parse.extractATData` → 修正为 `AtWs.extractATData`

### 测试

- Rust 单测 7/7；端到端（真实 Rust 后端 + mock 模组 + WS 客户端）**22/22**
- 前端解析层单测（carrier / reject / simsq）**19/19**
- LuCI 页面 JS 语法、菜单/ACL JSON、init.d/uci-defaults shell 语法全部通过
- 说明：OpenWrt SDK 交叉编译 / IPK·APK 实编译 / 真机安装验证需通过 GitHub Actions 云编译或本机 SDK 执行（见 `docs/02`）

[1.0.0]: https://github.com/LianXia233/luci-app-mt5700/releases/tag/v1.0.0
