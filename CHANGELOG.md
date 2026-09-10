# 更新日志 (Changelog)

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
